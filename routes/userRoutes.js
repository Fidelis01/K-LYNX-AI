const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const {protect} = require('../middleware/authMiddleware');

router.get('/:id', protect, userController.getProfile);
router.delete('/:id', protect, userController.removeUser);

//router.post('/login', loginController);

http://localhst:5000/auth/verify/:token
//router.get('/verify/:token', loginController.verifyEmail)

module.exports = router