const mysql = require('mysql2')
const bcrypt = require('bcrypt')

const dotenv = require('dotenv')
dotenv.config()

const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'klynx_db',
    port: process.env.MYSQL_PORT || 3306
}).promise()

module.exports = pool