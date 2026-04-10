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

// Your existing database connection
const db = new Pool({
    database: process.env.database,
    user: process.env.user,
    password: process.env.password,
    port: 5432,
    host: process.env.host || 'localhost',  // Add this
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(cors({
    origin: 'http://127.0.0.1:5500', 
    credentials: true
}))

app.use(express.json())
app.use(express.static('public'));

app.use('/auth', loginRoutes)

// BACKUP ENDPOINT - Add this
app.get('/backup', async (req, res) => {
    const { password } = req.query;
    
    // Check password from environment variable
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
        
        let sqlContent = `-- Database Backup\n-- Generated: ${new Date().toISOString()}\n\n`;
        
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
        
        // Save JSON backup
        const jsonBackup = {};
        for (const { table_name } of tablesResult.rows) {
            const data = await db.query(`SELECT * FROM ${table_name}`);
            jsonBackup[table_name] = data.rows;
        }
        const jsonFile = path.join(tempDir, `${backupId}.json`);
        fs.writeFileSync(jsonFile, JSON.stringify(jsonBackup, null, 2));
        
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
        
        console.log(`Backup completed: ${backupId}.zip`);
        
        // Send file for download
        res.download(zipPath, `${backupId}.zip`, (err) => {
            if (err) console.error('Download error:', err);
            setTimeout(() => {
                if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
            }, 30000);
        });
        
    } catch (error) {
        console.error('Backup failed:', error);
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
        res.status(500).json({ error: error.message });
    }
});

// Test database connection endpoint
app.get('/test-db', async (req, res) => {
    const { password } = req.query;
    
    if (!password || password !== process.env.BACKUP_PASSWORD) {
        return res.status(401).json({ error: 'Invalid password' });
    }
    
    try {
        const result = await db.query('SELECT NOW()');
        res.json({ success: true, time: result.rows[0].now });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Your existing route
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'))
})

const port = process.env.PORT || 5000

app.listen(port, () => {
    console.log(`Server is listening on port ${port}...`)
    console.log(`Backup endpoint: http://localhost:${port}/backup?password=YOUR_BACKUP_PASSWORD`)
})