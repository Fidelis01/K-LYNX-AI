const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const archiver = require('archiver');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Create HTTP server for WebSocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store active connections
const wsClients = new Map();
const adminSessions = new Map();
const callRooms = new Map();

// Database connection
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: false
});

const AI_API_URL = process.env.AI_API_URL || 'https://jai1-sh81.onrender.com';

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

// ============ WEBSOCKET HANDLER ============
wss.on('connection', (ws, req) => {
    const clientId = Math.random().toString(36).substr(2, 9);
    wsClients.set(clientId, { ws, room: null, name: null, lastActivity: Date.now() });
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            
            // Create call room
            if (message.type === 'create-call') {
                const roomId = Math.random().toString(36).substr(2, 8);
                callRooms.set(roomId, { 
                    creator: clientId, 
                    participant: null,
                    creatorName: message.name,
                    createdAt: Date.now()
                });
                wsClients.get(clientId).room = roomId;
                wsClients.get(clientId).name = message.name;
                ws.send(JSON.stringify({ type: 'call-created', roomId }));
            }
            
            // Join call room
            if (message.type === 'join-call') {
                const room = callRooms.get(message.roomId);
                if (room && !room.participant) {
                    room.participant = clientId;
                    room.participantName = message.name;
                    wsClients.get(clientId).room = message.roomId;
                    wsClients.get(clientId).name = message.name;
                    
                    const creator = wsClients.get(room.creator);
                    if (creator) {
                        creator.ws.send(JSON.stringify({ 
                            type: 'participant-joined', 
                            name: message.name,
                            participantId: clientId
                        }));
                    }
                    ws.send(JSON.stringify({ type: 'call-joined', roomId: message.roomId }));
                } else {
                    ws.send(JSON.stringify({ type: 'call-not-found' }));
                }
            }
            
            // WebRTC signaling
            if (message.type === 'offer') {
                const target = wsClients.get(message.targetId);
                if (target) {
                    target.ws.send(JSON.stringify({
                        type: 'offer',
                        offer: message.offer,
                        fromId: clientId,
                        fromName: wsClients.get(clientId).name
                    }));
                }
            }
            
            if (message.type === 'answer') {
                const target = wsClients.get(message.targetId);
                if (target) {
                    target.ws.send(JSON.stringify({
                        type: 'answer',
                        answer: message.answer,
                        fromId: clientId
                    }));
                }
            }
            
            if (message.type === 'ice-candidate') {
                const target = wsClients.get(message.targetId);
                if (target) {
                    target.ws.send(JSON.stringify({
                        type: 'ice-candidate',
                        candidate: message.candidate
                    }));
                }
            }
            
            // End call
            if (message.type === 'end-call') {
                const client = wsClients.get(clientId);
                if (client && client.room) {
                    const room = callRooms.get(client.room);
                    if (room) {
                        const otherId = room.creator === clientId ? room.participant : room.creator;
                        if (otherId) {
                            const other = wsClients.get(otherId);
                            if (other) {
                                other.ws.send(JSON.stringify({ type: 'call-ended' }));
                                other.room = null;
                            }
                        }
                        callRooms.delete(client.room);
                        client.room = null;
                        ws.send(JSON.stringify({ type: 'call-ended' }));
                    }
                }
            }
            
            // List active calls
            if (message.type === 'list-calls') {
                const activeCalls = [];
                callRooms.forEach((room, roomId) => {
                    if (!room.participant) {
                        activeCalls.push({ roomId, creatorName: room.creatorName });
                    }
                });
                ws.send(JSON.stringify({ type: 'calls-list', calls: activeCalls }));
            }
            
            // AI voice message
            if (message.type === 'voice') {
                const aiResponse = await getAIResponse(message.text);
                ws.send(JSON.stringify({ type: 'response', text: aiResponse }));
            }
            
            if (message.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            }
            
        } catch (err) {
            console.error('WebSocket error:', err);
        }
    });
    
    ws.on('close', () => {
        const client = wsClients.get(clientId);
        if (client && client.room) {
            const room = callRooms.get(client.room);
            if (room) {
                const otherId = room.creator === clientId ? room.participant : room.creator;
                if (otherId) {
                    const other = wsClients.get(otherId);
                    if (other) {
                        other.ws.send(JSON.stringify({ type: 'peer-disconnected' }));
                        other.room = null;
                    }
                }
                callRooms.delete(client.room);
            }
        }
        wsClients.delete(clientId);
    });
});

async function getAIResponse(userMessage) {
    try {
        const response = await fetch(`${AI_API_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: userMessage,
                clientId: 'voice-call',
                options: { speech: false }
            })
        });
        const data = await response.json();
        return data.response || "How can I help you?";
    } catch (error) {
        return "Sorry, I'm having trouble responding.";
    }
}

// ============ ADMIN AUTH ============
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === process.env.BACKUP_PASSWORD) {
        const sessionId = Date.now().toString() + Math.random().toString(36);
        adminSessions.set(sessionId, { createdAt: Date.now() });
        res.json({ success: true, sessionId });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

function verifyAdminSession(req, res, next) {
    const sessionId = req.headers['x-admin-session'];
    if (!sessionId || !adminSessions.has(sessionId)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const session = adminSessions.get(sessionId);
    if (Date.now() - session.createdAt > 3600000) {
        adminSessions.delete(sessionId);
        return res.status(401).json({ error: 'Session expired' });
    }
    next();
}

app.post('/api/admin/logout', (req, res) => {
    const sessionId = req.headers['x-admin-session'];
    if (sessionId) adminSessions.delete(sessionId);
    res.json({ success: true });
});

// ============ AUTH ROUTES ============
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password, language } = req.body;
        const existing = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await db.query(
            'INSERT INTO users (name, email, password, language) VALUES ($1, $2, $3, $4) RETURNING id, name, email',
            [name, email, hashedPassword, language || 'English']
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
        const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/users', async (req, res) => {
    try {
        const result = await db.query('SELECT id, name, email, language, created_at FROM users ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ ADMIN ROUTES ============
app.delete('/api/admin/users/:email', verifyAdminSession, async (req, res) => {
    try {
        const result = await db.query('DELETE FROM users WHERE email = $1 RETURNING *', [req.params.email]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/users/all', verifyAdminSession, async (req, res) => {
    try {
        const result = await db.query('DELETE FROM users RETURNING *');
        res.json({ success: true, message: `Deleted ${result.rowCount} users` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/backup', verifyAdminSession, async (req, res) => {
    try {
        const tables = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
        const timestamp = Date.now();
        const backupId = `backup_${timestamp}`;
        const tempDir = path.join(__dirname, backupId);
        fs.mkdirSync(tempDir);
        
        let sql = `-- Database Backup\n-- Generated: ${new Date().toISOString()}\n\n`;
        
        for (const { table_name } of tables.rows) {
            const data = await db.query(`SELECT * FROM ${table_name}`);
            sql += `DROP TABLE IF EXISTS ${table_name} CASCADE;\n`;
            const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table_name]);
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
        res.download(zipPath, `${backupId}.zip`, () => setTimeout(() => fs.unlinkSync(zipPath), 60000));
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
app.get('/ai-calls.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'AI-Calls.html')));

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Visit: https://klynxai.onrender.com`);
});