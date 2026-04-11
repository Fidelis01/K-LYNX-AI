const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const archiver = require('archiver');
const fs = require('fs');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database connection using connection string
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Create users table
async function initDB() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                language VARCHAR(100) DEFAULT 'English',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Database ready');
    } catch (err) {
        console.error('DB init error:', err.message);
    }
}
initDB();

// ============ AUTH ROUTES ============

// Register
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password, language } = req.body;
        
        // Check if user exists
        const existing = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }
        
        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Create user
        const result = await db.query(
            'INSERT INTO users (name, email, password, language) VALUES ($1, $2, $3, $4) RETURNING id, name, email',
            [name, email, hashedPassword, language || 'English']
        );
        
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Login
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign(
            { id: user.id, email: user.email }, 
            process.env.JWT_SECRET, 
            { expiresIn: '7d' }
        );
        
        res.json({
            success: true,
            token,
            user: { id: user.id, name: user.name, email: user.email }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all users (for admin)
app.get('/api/users', async (req, res) => {
    try {
        const result = await db.query('SELECT id, name, email, language, created_at FROM users ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete user by email
app.delete('/api/users/:email', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.BACKUP_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        const result = await db.query('DELETE FROM users WHERE email = $1 RETURNING *', [req.params.email]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({ success: true, message: `Deleted user: ${req.params.email}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete all users
app.delete('/api/users/all', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.BACKUP_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        const result = await db.query('DELETE FROM users RETURNING *');
        res.json({ success: true, message: `Deleted ${result.rowCount} users` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ BACKUP ROUTES ============

app.get('/api/backup', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.BACKUP_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        const tables = await db.query(`
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        `);
        
        const timestamp = Date.now();
        const backupId = `backup_${timestamp}`;
        const tempDir = path.join(__dirname, backupId);
        fs.mkdirSync(tempDir);
        
        let sql = `-- K-LYNX Database Backup\n-- Generated: ${new Date().toISOString()}\n\n`;
        
        for (const { table_name } of tables.rows) {
            const data = await db.query(`SELECT * FROM ${table_name}`);
            sql += `-- Table: ${table_name}\n`;
            sql += `DROP TABLE IF EXISTS ${table_name} CASCADE;\n`;
            
            // Get columns
            const cols = await db.query(`
                SELECT column_name FROM information_schema.columns 
                WHERE table_name = $1 AND table_schema = 'public'
            `, [table_name]);
            
            const colNames = cols.rows.map(c => c.column_name);
            sql += `CREATE TABLE ${table_name} (${colNames.map(c => `${c} TEXT`).join(', ')});\n`;
            
            for (const row of data.rows) {
                const values = colNames.map(c => {
                    const val = row[c];
                    if (val === null) return 'NULL';
                    return `'${String(val).replace(/'/g, "''")}'`;
                });
                sql += `INSERT INTO ${table_name} (${colNames.join(', ')}) VALUES (${values.join(', ')});\n`;
            }
            sql += `\n`;
        }
        
        fs.writeFileSync(path.join(tempDir, `${backupId}.sql`), sql);
        
        const zipPath = path.join(__dirname, `${backupId}.zip`);
        const archive = archiver('zip');
        const output = fs.createWriteStream(zipPath);
        
        await new Promise((resolve, reject) => {
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);
            archive.directory(tempDir, false);
            archive.finalize();
        });
        
        fs.rmSync(tempDir, { recursive: true });
        
        res.download(zipPath, `${backupId}.zip`, () => {
            setTimeout(() => fs.unlinkSync(zipPath), 60000);
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ SERVE PAGES ============
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/chat.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📱 Visit: http://localhost:${PORT}/signup.html`);
});