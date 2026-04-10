// Import packages
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
const bcrypt = require('bcrypt');

// CORS configuration - FIXED
app.use(cors({
    origin: ['https://klynxai.onrender.com', 'http://localhost:5000', 'http://127.0.0.1:5500'],
    credentials: true
}));

app.use(express.json())
app.use(express.static('public'));

app.use('/auth', loginRoutes)

// Database connection
const db = new Pool({
    database: process.env.database,
    user: process.env.user,
    password: process.env.password,
    host: process.env.host || 'localhost',
    port: 5432,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// CREATE USERS TABLE AUTOMATICALLY
async function createUsersTable() {
    try {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                language VARCHAR(100),
                is_verified BOOLEAN DEFAULT FALSE,
                verification_token VARCHAR(255),
                reset_password_token VARCHAR(255),
                reset_password_expires TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;
        
        await db.query(createTableQuery);
        console.log('✅ Users table ready');
        
        // Create index for faster email lookups
        await db.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);');
        console.log('✅ Email index created');
        
    } catch (error) {
        console.error('❌ Table creation error:', error.message);
    }
}

// Call the function to create table
createUsersTable();

// Test database connection endpoint
app.get('/test-db', async (req, res) => {
    const { password } = req.query;
    
    if (!password || password !== process.env.BACKUP_PASSWORD) {
        return res.status(401).json({ error: 'Invalid password' });
    }
    
    try {
        const result = await db.query('SELECT NOW()');
        res.json({ 
            success: true, 
            message: 'Database connected successfully',
            timestamp: result.rows[0].now
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Check database table endpoint
app.get('/check-db', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'users'
            );
        `);
        res.json({ tableExists: result.rows[0].exists });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// Test registration endpoint (for debugging)
app.post('/test-register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const result = await db.query(
            'INSERT INTO users (name, email, password, is_verified, created_at) VALUES ($1, $2, $3, true, NOW()) RETURNING id',
            [name, email, hashedPassword]
        );
        
        res.json({ success: true, userId: result.rows[0].id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// BACKUP ENDPOINT - Download database backup
app.get('/backup', async (req, res) => {
    const { password } = req.query;
    
    if (!password || password !== process.env.BACKUP_PASSWORD) {
        return res.status(401).json({ error: 'Invalid password' });
    }
    
    const timestamp = Date.now();
    const backupId = `backup_${timestamp}`;
    const tempDir = path.join(__dirname, backupId);
    
    try {
        console.log('Starting database backup...');
        fs.mkdirSync(tempDir);
        
        // Get all tables
        const tablesResult = await db.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_type = 'BASE TABLE'
        `);
        
        if (tablesResult.rows.length === 0) {
            throw new Error('No tables found in database');
        }
        
        let sqlContent = `-- Database Backup\n-- Generated: ${new Date().toISOString()}\n-- Database: ${process.env.database}\n\n`;
        
        for (const { table_name } of tablesResult.rows) {
            console.log(`Backing up: ${table_name}`);
            
            // Get table structure
            const structure = await db.query(`
                SELECT column_name, data_type, is_nullable, column_default
                FROM information_schema.columns 
                WHERE table_schema = 'public' AND table_name = $1
                ORDER BY ordinal_position
            `, [table_name]);
            
            // Create table SQL
            sqlContent += `DROP TABLE IF EXISTS ${table_name} CASCADE;\n`;
            sqlContent += `CREATE TABLE ${table_name} (\n`;
            const cols = structure.rows.map(col => {
                let def = `  ${col.column_name} ${col.data_type}`;
                if (col.column_default) def += ` DEFAULT ${col.column_default}`;
                if (col.is_nullable === 'NO') def += ` NOT NULL`;
                return def;
            });
            sqlContent += cols.join(',\n');
            sqlContent += `\n);\n\n`;
            
            // Get data
            const data = await db.query(`SELECT * FROM ${table_name}`);
            
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
                    sqlContent += `INSERT INTO ${table_name} (${columns.join(', ')}) VALUES (${values.join(', ')});\n`;
                }
                sqlContent += `\n`;
            }
        }
        
        // Save SQL file
        const sqlFile = path.join(tempDir, `${backupId}.sql`);
        fs.writeFileSync(sqlFile, sqlContent);
        console.log(`SQL backup saved: ${backupId}.sql`);
        
        // Save JSON backup
        const jsonBackup = {};
        for (const { table_name } of tablesResult.rows) {
            const data = await db.query(`SELECT * FROM ${table_name}`);
            jsonBackup[table_name] = data.rows;
        }
        const jsonFile = path.join(tempDir, `${backupId}.json`);
        fs.writeFileSync(jsonFile, JSON.stringify(jsonBackup, null, 2));
        console.log(`JSON backup saved: ${backupId}.json`);
        
        // Create README
        const readmeFile = path.join(tempDir, 'README.txt');
        const readmeContent = `
DATABASE BACKUP - ${new Date().toISOString()}
=============================================

Database: ${process.env.database}
Host: ${process.env.host}

Files included:
- ${backupId}.sql - SQL dump (recommended for restore)
- ${backupId}.json - JSON format backup

Tables backed up: ${tablesResult.rows.map(t => t.table_name).join(', ')}

To restore:
psql -h NEW_HOST -U NEW_USER -d NEW_DATABASE < ${backupId}.sql
        `;
        fs.writeFileSync(readmeFile, readmeContent);
        
        // Create ZIP file
        const zipPath = path.join(__dirname, `${backupId}.zip`);
        const archive = archiver('zip', { zlib: { level: 9 } });
        const output = fs.createWriteStream(zipPath);
        
        await new Promise((resolve, reject) => {
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);
            archive.directory(tempDir, false);
            archive.finalize();
        });
        
        // Clean up temp directory
        fs.rmSync(tempDir, { recursive: true });
        
        const fileSize = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(2);
        console.log(`Backup completed: ${backupId}.zip (${fileSize} MB)`);
        
        // Send file for download
        res.download(zipPath, `${backupId}.zip`, (err) => {
            if (err) {
                console.error('Download error:', err);
            }
            // Delete zip file after 30 seconds
            setTimeout(() => {
                if (fs.existsSync(zipPath)) {
                    fs.unlinkSync(zipPath);
                    console.log(`Cleaned up: ${backupId}.zip`);
                }
            }, 30000);
        });
        
    } catch (error) {
        console.error('Backup failed:', error);
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        res.status(500).json({ error: 'Backup failed', message: error.message });
    }
});

// Get database status endpoint
app.get('/db-status', async (req, res) => {
    const { password } = req.query;
    
    if (!password || password !== process.env.BACKUP_PASSWORD) {
        return res.status(401).json({ error: 'Invalid password' });
    }
    
    try {
        const tablesResult = await db.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_type = 'BASE TABLE'
        `);
        
        const tableInfo = [];
        let totalRows = 0;
        
        for (const { table_name } of tablesResult.rows) {
            const count = await db.query(`SELECT COUNT(*) FROM ${table_name}`);
            const rowCount = parseInt(count.rows[0].count);
            totalRows += rowCount;
            tableInfo.push({
                name: table_name,
                rows: rowCount
            });
        }
        
        res.json({
            success: true,
            database: process.env.database,
            tables: tableInfo,
            total_tables: tablesResult.rows.length,
            total_rows: totalRows,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Routes for HTML pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/signup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/chat', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// Start server
const port = process.env.PORT || 5000

app.listen(port, () => {
    console.log(`Server is listening on port ${port}...`)
    console.log(`✅ Database: ${process.env.database}`)
    console.log(`✅ Backup endpoint: /backup?password=YOUR_PASSWORD`)
    console.log(`✅ Test DB: /test-db?password=YOUR_PASSWORD`)
    console.log(`✅ Check table: /check-db`)
})