// Import packages
const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

dotenv.config();

const app = express();

// CORS configuration
app.use(cors({
    origin: ['https://klynxai.onrender.com', 'http://localhost:5000', 'http://127.0.0.1:5500'],
    credentials: true
}));

app.use(express.json());
app.use(express.static('public'));

// Database connection
const db = new Pool({
    database: process.env.database,
    user: process.env.user,
    password: process.env.password,
    host: process.env.host || 'localhost',
    port: 5432,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Create users table
async function createUsersTable() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                language VARCHAR(100),
                is_verified BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Users table ready');
    } catch (error) {
        console.error('Table creation error:', error.message);
    }
}
createUsersTable();

// ========== REGISTER ENDPOINT ==========
app.post('/register', async (req, res) => {
    try {
        const { name, email, password, language } = req.body;
        
        console.log('Registration attempt for:', email);
        
        // Check if user exists
        const existingUser = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ message: 'Email already in use!' });
        }
        
        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Insert user
        const result = await db.query(
            'INSERT INTO users (name, email, password, language) VALUES ($1, $2, $3, $4) RETURNING id, name, email',
            [name, email, hashedPassword, language || 'English']
        );
        
        console.log('User created:', result.rows[0]);
        
        res.status(201).json({ 
            success: true,
            message: 'Account created successfully! You can now login.',
            user: result.rows[0]
        });
        
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Registration failed: ' + error.message 
        });
    }
});

// ========== LOGIN ENDPOINT ==========
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        console.log('Login attempt for:', email);
        
        // Find user
        const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }
        
        const user = result.rows[0];
        
        // Check password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }
        
        // Create token
        const token = jwt.sign(
            { id: user.id, email: user.email },
            process.env.JWT_SECRET || 'your-secret-key',
            { expiresIn: '7d' }
        );
        
        res.json({
            success: true,
            message: 'Login successful',
            token: token,
            user: { id: user.id, name: user.name, email: user.email }
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error: ' + error.message });
    }
});

// ========== GET USERS (for testing) ==========
app.get('/users', async (req, res) => {
    try {
        const result = await db.query('SELECT id, name, email, language, created_at FROM users');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== TEST DB ENDPOINT ==========
app.get('/test-db', async (req, res) => {
    try {
        const result = await db.query('SELECT NOW()');
        res.json({ 
            success: true, 
            message: 'Database connected',
            time: result.rows[0].now
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE user by email
app.delete('/delete-user', async (req, res) => {
    const { password, email } = req.query;
    
    if (password !== process.env.BACKUP_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        const result = await db.query('DELETE FROM users WHERE email = $1 RETURNING *', [email]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({ 
            success: true, 
            message: `Deleted user: ${email}`,
            deleted: result.rows[0]
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE all users
app.delete('/delete-all-users', async (req, res) => {
    const { password } = req.query;
    
    if (password !== process.env.BACKUP_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        const result = await db.query('DELETE FROM users RETURNING *');
        
        res.json({ 
            success: true, 
            message: `Deleted ${result.rows.length} users`,
            deleted: result.rows.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Reset database (drop and recreate table)
app.post('/reset-database', async (req, res) => {
    const { password } = req.query;
    
    if (password !== process.env.BACKUP_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        await db.query('DROP TABLE IF EXISTS users');
        await db.query(`
            CREATE TABLE users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                language VARCHAR(100),
                is_verified BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        res.json({ success: true, message: 'Database reset successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== SERVE HTML PAGES ==========
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/signup.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/chat.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// Start server
const port = process.env.PORT || 5000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`http://localhost:${port}`);
});