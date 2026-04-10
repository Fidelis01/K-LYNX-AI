// models/userModel.js
const { Pool } = require('pg');

const db = new Pool({
    database: process.env.database,
    user: process.env.user,
    password: process.env.password,
    host: process.env.host,
    port: 5432,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Get user by email
exports.getUsersByEmail = async (email) => {
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    return result.rows[0];
};

// Get user by verification token
exports.getUserByToken = async (token) => {
    const result = await db.query('SELECT * FROM users WHERE verification_token = $1', [token]);
    return result.rows[0];
};

// Get user by reset token
exports.getUsersByResetToken = async (token) => {
    const result = await db.query('SELECT * FROM users WHERE reset_password_token = $1 AND reset_password_expires > NOW()', [token]);
    return result.rows[0];
};

// Create new user
exports.createUser = async (name, email, password, language, token) => {
    const hashedPassword = await require('bcrypt').hash(password, 10);
    
    const result = await db.query(
        'INSERT INTO users (name, email, password, language, verification_token, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id',
        [name, email, hashedPassword, language, token]
    );
    return result.rows[0];
};

// Mark user as verified
exports.markAsVerifiedUser = async (userId) => {
    await db.query(
        'UPDATE users SET is_verified = true, verification_token = NULL WHERE id = $1',
        [userId]
    );
};

// Set reset token
exports.setResetToken = async (email, token, expiry) => {
    await db.query(
        'UPDATE users SET reset_password_token = $1, reset_password_expires = $2 WHERE email = $3',
        [token, expiry, email]
    );
};

// Update password
exports.updatePassword = async (userId, hashedPassword) => {
    await db.query(
        'UPDATE users SET password = $1, reset_password_token = NULL, reset_password_expires = NULL WHERE id = $2',
        [hashedPassword, userId]
    );
};