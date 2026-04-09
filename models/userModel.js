const pool = require('../database');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

async function createUser(name, email, password, language, verificationToken) {
    try{
        //const verificationToken = crypto.randomBytes(32).toString('hex');
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const [result] = await pool.query ('INSERT INTO users (name, email, password, language, verification_token) VALUES (?, ?, ?, ?, ?)', [name, email, hashedPassword, language, verificationToken])
        return { userId: result.insertId, /*token: verificationToken*/ };
        } catch (err) {
        console.error('Database Error:', err.message);
        throw err
        }
    }

    async function getUsersByEmail(email) {
        try {
            const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
            return rows[0]; 
        } catch (err) {
            console.error('Database Error:', err.message);
            throw err; 
        }
    }

    
    async function getUsers(id) {
        try {
            const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id])
            return rows[0];
        } catch (err) {
            console.error('Database Error:', err.message);
            throw err
        }
    }
    
    async function deleteUser(id){
        try {
            const[result] = await pool.query('DELETE FROM users WHERE id = ?', [id]);
    
            if ( result.affectedRows === 0){
                console.log(`No user found with ID: ${id}`);
                return false;
            }
    
            console.log(`User wit ID ${id} deleted succesfully.`);
            return true;
        } catch (err) {
            console.log('Database Error:', err.message);
            throw err
        }
    }
    
    async function updateUser(id, name, email, password, language) {
        try{
            const [result] = await pool.query('UPDATE users SET name = ?, email = ? password = ?, languae = ?, WHERE id = ?', [name, email, password, language, id]);
            return result.affectedRows > 0;
        } catch (err) {
            console.log('Database Error:', err.message);
            throw err;
        }
    
    
    }
    
    
    async function loginUser(email, password) {
        const user = await getUsersByEmail(email);
    
        if(!user) {
            return {success: false, message: "User not found"};
        }
    
        const isMatch = await bcrypt.compare(password, user.password);
    
        if(isMatch) {
            return {success: true, user: user};
        } else {
            return {success: false, message: 'Incorrect Password'};
        }
    }

    async function runSecurityTest() {
    try {
        console.log('starting security');
        const testName = 'TestUs';
        const testPass= 'SuperSecret11';
        const testEmail = 'texztemails@example.com';
        const testLang = 'english';

        const newId = await createUser(testName, testPass, testLang, testEmail);
        console.log(`user created with ID: ${newId}`);
        
        const user = await getUsers(newId)
        console.log('Database result');
        console.log(`Name : ${user.name}`);
        console.log(`Plain password sent : ${testPass}`);
        console.log(`Stored password in DB: ${user.password}`);
        
        const isMatch = await bcrypt.compare(testPass, user.password)
        console.log(`\n password Match Verification: ${isMatch ? "SUCCESS (Hashes Match)": "FAILED"}`);
    } catch (err) {
        console.error("Test failed:", err.message);
        
    }
}

async function getUserByToken(token) {
    const [rows] = await pool.query ('SELECT * FROM users WHERE verification_token = ?', [token]);
    return rows[0];
}

async function markAsVerifiedUser(userId) {
    await pool.query('Update users SET is_verified = 1, verification_token = NULL WHERE id = ?', [userId])
}

async function setResetToken(email, token, expiry) {
    await pool.query('UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE email = ?', [token, expiry, email]);
}

async function getUsersByResetToken(token) {
    const [rows] = await pool.query('SELECT * FROM users WHERE reset_token = ? AND reset_token_expiry > NOW()', [token]);
    return rows[0]
}

async function updatePassword(userId, hashedPassword) {
    await pool.query('UPDATE users SET password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?', [hashedPassword, userId])
}

//runSecurityTest()
    
    module.exports = {
    getUsers,
    createUser,
    deleteUser,
    updateUser,
    getUsersByEmail,
    getUserByToken,
    markAsVerifiedUser,
    setResetToken,
    getUsersByResetToken,
    updatePassword,
    loginUser,
    runSecurityTest
    }
