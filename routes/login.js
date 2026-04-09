const express = require('express')
const router = express.Router()
const path = require('path')

const loginController = require('../controllers/login')

router.post('/register', loginController.register)

router.get('/verify/:token', loginController.verifyEmail);

router.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/login.html'));
});

router.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/dashboard'));
});

router.post('/login',loginController.loginUser)

router.post('/forgot-password', loginController.forgotPassword);
router.post('/reset-password/:token', loginController.resetPassword)

module.exports = router 