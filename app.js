//Importing express using npm 
const express = require('express')
const app = express();
const path = require('path')
const dotenv = require('dotenv');
dotenv.config();
const loginRoutes = require('./routes/login')
const cors = require('cors')
const { Pool } = require('pg');
const fs = require('fs');
const archiver = require('archiver');

app.use(cors({
    origin: 'http://127.0.0.1:5500', 
    credentials: true
}))

app.use(express.json())
app.use(express.static('public'));

const loginRoutees = require('./routes/login')

app.use('/auth', loginRoutes)

// Database configuration for backup
const db = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Backup directory
const BACKUP_DIR = path.join(__dirname, 'temp_backups');
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Helper: Get all table names
async function getAllTables() {
    const query = `
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
        ORDER BY table_name;
    `;
    const result = await db.query(query);
    return result.rows.map(row => row.table_name);
}

// Helper: Get table structure
async function getTableStructure(tableName) {
    const columnsQuery = `
        SELECT 
            column_name,
            data_type,
            is_nullable,
            column_default
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = $1
        ORDER BY ordinal_position;
    `;
    const columns = await db.query(columnsQuery, [tableName]);
    
    const constraintsQuery = `
        SELECT
            tc.constraint_type,
            tc.constraint_name,
            kcu.column_name,
            ccu.table_name AS foreign_table_name,
            ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu 
            ON tc.constraint_name = kcu.constraint_name
        LEFT JOIN information_schema.constraint_column_usage ccu 
            ON ccu.constraint_name = tc.constraint_name
        WHERE tc.table_name = $1 
            AND tc.table_schema = 'public';
    `;
    const constraints = await db.query(constraintsQuery, [tableName]);
    
    return { columns: columns.rows, constraints: constraints.rows };
}

// Helper: Export table data to SQL format
async function exportTableToSQL(tableName) {
    const data = await db.query(`SELECT * FROM ${tableName}`);
    const structure = await getTableStructure(tableName);
    
    let sql = `-- Table: ${tableName}\n`;
    sql += `DROP TABLE IF EXISTS ${tableName} CASCADE;\n\n`;
    
    // Create table SQL
    sql += `CREATE TABLE ${tableName} (\n`;
    const columnDefs = structure.columns.map(col => {
        let def = `  ${col.column_name} ${col.data_type}`;
        if (col.column_default) def += ` DEFAULT ${col.column_default}`;
        if (col.is_nullable === 'NO') def += ` NOT NULL`;
        return def;
    });
    
    const primaryKey = structure.constraints.find(c => c.constraint_type === 'PRIMARY KEY');
    if (primaryKey) {
        columnDefs.push(`  PRIMARY KEY (${primaryKey.column_name})`);
    }
    
    sql += columnDefs.join(',\n');
    sql += `\n);\n\n`;
    
    // Insert data
    if (data.rows.length > 0) {
        const columns = Object.keys(data.rows[0]);
        for (const row of data.rows) {
            const values = columns.map(col => {
                const val = row[col];
                if (val === null) return 'NULL';
                if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
                return `'${String(val).replace(/'/g, "''")}'`;
            });
            sql += `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')});\n`;
        }
        sql += `\n`;
    }
    
    return sql;
}

// BACKUP ENDPOINT - Download database backup
app.get('/backup', async (req, res) => {
    const { password } = req.query;
    
    // Check password from environment variable
    if (!password || password !== process.env.BACKUP_PASSWORD) {
        return res.status(401).json({ 
            error: 'Unauthorized', 
            message: 'Valid password required as query parameter: ?password=xxx' 
        });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupId = `backup_${timestamp}`;
    const tempDir = path.join(BACKUP_DIR, backupId);
    
    try {
        console.log(`[${new Date().toISOString()}] Starting backup...`);
        
        // Create temp directory for this backup
        fs.mkdirSync(tempDir, { recursive: true });
        
        // Get all tables
        const tables = await getAllTables();
        console.log(`Found ${tables.length} tables to backup`);
        
        if (tables.length === 0) {
            throw new Error('No tables found in database');
        }
        
        // Create SQL dump file
        const sqlDumpPath = path.join(tempDir, `${backupId}.sql`);
        const sqlDumpStream = fs.createWriteStream(sqlDumpPath);
        
        // Write header
        sqlDumpStream.write(`-- PostgreSQL Database Backup\n`);
        sqlDumpStream.write(`-- Generated: ${new Date().toISOString()}\n`);
        sqlDumpStream.write(`-- Database: ${process.env.DB_NAME}\n`);
        sqlDumpStream.write(`-- Host: ${process.env.DB_HOST}\n`);
        sqlDumpStream.write(`-- Tables: ${tables.length}\n\n`);
        sqlDumpStream.write(`-- Enable foreign key checks\n`);
        sqlDumpStream.write(`SET session_replication_role = 'replica';\n\n`);
        
        // Export each table to SQL
        for (const tableName of tables) {
            console.log(`Exporting table: ${tableName}`);
            const tableSQL = await exportTableToSQL(tableName);
            sqlDumpStream.write(tableSQL);
            sqlDumpStream.write(`\n-- End of table: ${tableName}\n\n`);
        }
        
        // Disable foreign key checks at the end
        sqlDumpStream.write(`\n-- Restore foreign key checks\n`);
        sqlDumpStream.write(`SET session_replication_role = 'origin';\n`);
        
        sqlDumpStream.end();
        
        // Wait for SQL file to finish writing
        await new Promise((resolve) => sqlDumpStream.on('finish', resolve));
        
        // Also create JSON backup as alternative format
        const jsonBackup = {};
        for (const tableName of tables) {
            const data = await db.query(`SELECT * FROM ${tableName}`);
            jsonBackup[tableName] = data.rows;
        }
        
        const jsonPath = path.join(tempDir, `${backupId}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(jsonBackup, null, 2));
        
        // Create README file
        const readmePath = path.join(tempDir, 'README.txt');
        const tableList = tables.join(', ');
        fs.writeFileSync(readmePath, `
================================================================
DATABASE BACKUP - ${new Date().toISOString()}
================================================================

This backup was created from: ${process.env.DB_HOST}
Database name: ${process.env.DB_NAME}

FILES INCLUDED:
---------------
1. ${backupId}.sql - SQL dump (RECOMMENDED for restoration)
2. ${backupId}.json - JSON format backup (alternative)
3. README.txt - This file

TABLES BACKED UP:
-----------------
${tables.map((t, i) => `${i+1}. ${t}`).join('\n')}

Total tables: ${tables.length}

HOW TO RESTORE TO A NEW POSTGRESQL DATABASE:
--------------------------------------------

Option 1: Using psql (Recommended)
1. Create a new PostgreSQL database on Render
2. Get your new database credentials (host, username, database name, password)
3. Run this command:
   psql -h NEW_DATABASE_HOST -U NEW_USERNAME -d NEW_DATABASE_NAME < ${backupId}.sql

Option 2: Using pg_restore (if you have a custom format)
   pg_restore -h NEW_HOST -U NEW_USER -d NEW_DB --no-owner --no-privileges ${backupId}.sql

Option 3: Using the JSON backup (Node.js script)
   const { Pool } = require('pg');
   const backup = require('./${backupId}.json');
   // Then insert data programmatically

IMPORTANT NOTES:
----------------
- Make sure your new database is empty before restoring
- The SQL file will automatically drop and recreate tables
- Foreign key constraints are temporarily disabled during restore
- Backup password: ${process.env.BACKUP_PASSWORD}

TIMESTAMP: ${new Date().toString()}
================================================================
        `);
        
        // Create ZIP file
        const zipFilename = `${backupId}.zip`;
        const zipPath = path.join(BACKUP_DIR, zipFilename);
        
        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 9 } });
            
            output.on('close', resolve);
            archive.on('error', reject);
            
            archive.pipe(output);
            archive.directory(tempDir, backupId);
            archive.finalize();
        });
        
        // Clean up temp directory
        fs.rmSync(tempDir, { recursive: true, force: true });
        
        const fileSize = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(2);
        console.log(`Backup completed: ${zipFilename} (${fileSize} MB)`);
        
        // Send file for download
        res.download(zipPath, zipFilename, (err) => {
            if (err) {
                console.error('Download error:', err);
                res.status(500).json({ error: 'Download failed' });
            }
            // Delete zip file after download (30 seconds)
            setTimeout(() => {
                if (fs.existsSync(zipPath)) {
                    fs.unlinkSync(zipPath);
                    console.log(`Cleaned up: ${zipFilename}`);
                }
            }, 30000);
        });
        
    } catch (error) {
        console.error('Backup failed:', error);
        // Clean up on error
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        res.status(500).json({ 
            error: 'Backup failed', 
            message: error.message 
        });
    }
});

// STATUS ENDPOINT - Check database status
app.get('/db-status', async (req, res) => {
    const { password } = req.query;
    
    if (!password || password !== process.env.BACKUP_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        const tables = await getAllTables();
        const tableInfo = [];
        let totalRows = 0;
        
        for (const tableName of tables) {
            const count = await db.query(`SELECT COUNT(*) FROM ${tableName}`);
            const rowCount = parseInt(count.rows[0].count);
            totalRows += rowCount;
            tableInfo.push({
                name: tableName,
                rows: rowCount
            });
        }
        
        // Get database size
        const dbSize = await db.query(`
            SELECT pg_database_size($1) as size,
                   pg_size_pretty(pg_database_size($1)) as size_pretty
        `, [process.env.DB_NAME]);
        
        res.json({
            success: true,
            database: {
                name: process.env.DB_NAME,
                host: process.env.DB_HOST,
                size: dbSize.rows[0].size_pretty,
                size_bytes: dbSize.rows[0].size
            },
            tables: tableInfo,
            statistics: {
                total_tables: tables.length,
                total_rows: totalRows,
                backup_available: true
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Status check failed:', error);
        res.status(500).json({ 
            error: 'Failed to get database status', 
            message: error.message 
        });
    }
});

// Test database connection endpoint
app.get('/test-db', async (req, res) => {
    const { password } = req.query;
    
    if (!password || password !== process.env.BACKUP_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        await db.query('SELECT NOW()');
        res.json({ 
            success: true, 
            message: 'Database connection successful',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

//middleware
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'))
})

const port = process.env.PORT || 5000

app.listen(port, () => {
    console.log(`Server is listening on port ${port}...`)
    console.log(`Backup endpoint: http://localhost:${port}/backup?password=YOUR_PASSWORD`)
    console.log(`Status endpoint: http://localhost:${port}/db-status?password=YOUR_PASSWORD`)
})