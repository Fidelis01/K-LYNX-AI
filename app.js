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

// Store active WebSocket connections
const wsClients = new Map();

// Simple session storage (in production, use a proper session store)
const adminSessions = new Map();

// Database connection using connection string
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: false
});

// AI API URL
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

// ============ WEBSOCKET VOICE CALL HANDLER ============
const { v4: uuidv4 } = require('uuid');

// Store active call rooms
const callRooms = new Map();

// WebRTC Signaling
wss.on('connection', (ws, req) => {
    const clientId = uuidv4();
    wsClients.set(clientId, { ws, room: null, name: null });
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            
            // Create or join a call room
            if (message.type === 'create-call') {
                const roomId = uuidv4().substr(0, 8);
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
            
            // Join an existing call
            if (message.type === 'join-call') {
                const room = callRooms.get(message.roomId);
                if (room && !room.participant) {
                    room.participant = clientId;
                    room.participantName = message.name;
                    callRooms.set(message.roomId, room);
                    wsClients.get(clientId).room = message.roomId;
                    wsClients.get(clientId).name = message.name;
                    
                    // Notify creator that someone joined
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
                    ws.send(JSON.stringify({ type: 'call-not-found', error: 'Room not available' }));
                }
            }
            
            // WebRTC signaling (offer, answer, ice-candidate)
            if (message.type === 'offer') {
                const targetClient = wsClients.get(message.targetId);
                if (targetClient) {
                    targetClient.ws.send(JSON.stringify({
                        type: 'offer',
                        offer: message.offer,
                        fromId: clientId,
                        fromName: wsClients.get(clientId).name
                    }));
                }
            }
            
            if (message.type === 'answer') {
                const targetClient = wsClients.get(message.targetId);
                if (targetClient) {
                    targetClient.ws.send(JSON.stringify({
                        type: 'answer',
                        answer: message.answer,
                        fromId: clientId
                    }));
                }
            }
            
            if (message.type === 'ice-candidate') {
                const targetClient = wsClients.get(message.targetId);
                if (targetClient) {
                    targetClient.ws.send(JSON.stringify({
                        type: 'ice-candidate',
                        candidate: message.candidate
                    }));
                }
            }
            
            // End call
            if (message.type === 'end-call') {
                const room = callRooms.get(wsClients.get(clientId).room);
                if (room) {
                    const otherId = room.creator === clientId ? room.participant : room.creator;
                    if (otherId) {
                        const other = wsClients.get(otherId);
                        if (other) {
                            other.ws.send(JSON.stringify({ type: 'call-ended' }));
                            other.room = null;
                        }
                    }
                    callRooms.delete(wsClients.get(clientId).room);
                    wsClients.get(clientId).room = null;
                    ws.send(JSON.stringify({ type: 'call-ended' }));
                }
            }
            
            // List active calls
            if (message.type === 'list-calls') {
                const activeCalls = [];
                callRooms.forEach((room, roomId) => {
                    if (!room.participant) {
                        activeCalls.push({
                            roomId,
                            creatorName: room.creatorName,
                            createdAt: room.createdAt
                        });
                    }
                });
                ws.send(JSON.stringify({ type: 'calls-list', calls: activeCalls }));
            }
            
        } catch (err) {
            console.error('WebRTC signaling error:', err);
        }
    });
    
    ws.on('close', () => {
        // Clean up rooms when user disconnects
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

wss.on('connection', (ws, req) => {
    const clientId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9);
    wsClients.set(clientId, { ws, lastActivity: Date.now(), context: {} });
    console.log(`🎤 Voice client ${clientId} connected`);

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            
            if (message.type === 'voice') {
                // Process voice message and get AI response
                const client = wsClients.get(clientId);
                const aiResponse = await getAIResponse(message.text, client.context);
                
                // Update context for conversation continuity
                client.context.lastMessage = message.text;
                client.context.lastResponse = aiResponse;
                wsClients.set(clientId, client);
                
                // Send response back
                ws.send(JSON.stringify({ 
                    type: 'response', 
                    text: aiResponse,
                    timestamp: Date.now()
                }));
            }
            
            if (message.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
                const client = wsClients.get(clientId);
                if (client) {
                    client.lastActivity = Date.now();
                    wsClients.set(clientId, client);
                }
            }
            
            if (message.type === 'context') {
                const client = wsClients.get(clientId);
                client.context = { ...client.context, ...message.data };
                wsClients.set(clientId, client);
            }
            
        } catch (err) {
            console.error('WebSocket message error:', err);
            ws.send(JSON.stringify({ type: 'error', text: 'Failed to process message' }));
        }
    });

    ws.on('close', () => {
        wsClients.delete(clientId);
        console.log(`🎤 Voice client ${clientId} disconnected`);
    });
});

// AI response function for voice calls
async function getAIResponse(userMessage, context) {
    try {
        const response = await fetch(`${AI_API_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: userMessage,
                clientId: context.clientId || 'voice-call-' + Date.now(),
                options: { speech: false }
            })
        });
        const data = await response.json();
        return data.response || "I received your message. How can I help you today?";
    } catch (error) {
        console.error('AI API error:', error);
        return "Sorry, I'm having trouble responding right now. Please try again in a moment.";
    }
}

// Health check for WebSocket
app.get('/api/ws-status', (req, res) => {
    res.json({ 
        status: 'online', 
        clients: wsClients.size,
        timestamp: new Date().toISOString()
    });
});

// ============ ADMIN AUTH ============

// Admin login - creates a session
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

// Middleware to verify admin session
function verifyAdminSession(req, res, next) {
    const sessionId = req.headers['x-admin-session'];
    
    if (!sessionId || !adminSessions.has(sessionId)) {
        return res.status(401).json({ error: 'Unauthorized - Please login to admin panel' });
    }
    
    // Check if session is expired (1 hour)
    const session = adminSessions.get(sessionId);
    if (Date.now() - session.createdAt > 3600000) {
        adminSessions.delete(sessionId);
        return res.status(401).json({ error: 'Session expired - Please login again' });
    }
    
    next();
}

// Admin logout
app.post('/api/admin/logout', (req, res) => {
    const sessionId = req.headers['x-admin-session'];
    if (sessionId) {
        adminSessions.delete(sessionId);
    }
    res.json({ success: true });
});

// ============ AUTH ROUTES ============

// Register
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

// Get all users (no auth needed for admin panel to load)
app.get('/api/users', async (req, res) => {
    try {
        const result = await db.query('SELECT id, name, email, language, created_at FROM users ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ PROTECTED ADMIN ROUTES (require session) ============

// Delete user by email - PROTECTED
app.delete('/api/admin/users/:email', verifyAdminSession, async (req, res) => {
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

// Delete all users - PROTECTED
app.delete('/api/admin/users/all', verifyAdminSession, async (req, res) => {
    try {
        const result = await db.query('DELETE FROM users RETURNING *');
        res.json({ success: true, message: `Deleted ${result.rowCount} users` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Backup database - PROTECTED
app.get('/api/admin/backup', verifyAdminSession, async (req, res) => {
    try {
        const tables = await db.query(`
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        `);
        
        const timestamp = Date.now();
        const backupId = `backup_${timestamp}`;
        const tempDir = path.join(__dirname, backupId);
        fs.mkdirSync(tempDir);
        
        let sql = `-- Database Backup\n-- Generated: ${new Date().toISOString()}\n\n`;
        
        for (const { table_name } of tables.rows) {
            const data = await db.query(`SELECT * FROM ${table_name}`);
            sql += `-- Table: ${table_name}\n`;
            sql += `DROP TABLE IF EXISTS ${table_name} CASCADE;\n`;
            
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


// Start server with WebSocket support
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 HTTP Server running on port ${PORT}`);
    console.log(`🔌 WebSocket Server running on ws://localhost:${PORT}`);
    console.log(`📱 Visit: https://klynxai.onrender.com`);
});