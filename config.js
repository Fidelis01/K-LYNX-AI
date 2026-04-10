// config.js - This can be in your repo since it doesn't contain real values
const config = {
    port: process.env.PORT || 5000,
    db: {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 5432,
        name: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ssl: process.env.NODE_ENV === 'production'
    },
    backupPassword: process.env.BACKUP_PASSWORD,
    environment: process.env.NODE_ENV || 'development'
};

// Validation
if (!config.backupPassword && config.environment === 'production') {
    console.error('ERROR: BACKUP_PASSWORD is not set in environment variables');
}

module.exports = config;