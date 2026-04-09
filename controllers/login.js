const User = require('../models/userModel');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto')
const sendVerificationEmail = require('../utils/sendEmail');
const express = require('express');
const router = express.Router()
const authController = require('../controllers/login');
const { log } = require('console');

exports.register = async (req, res) => {
    try{
        const { name, email, password, language } = req.body;
        
        const existingUser = await User.getUsersByEmail(email);
        if (existingUser) {
            return res.status(400).json({message: 'Email already in use!'})
        }

        const token  = crypto.randomBytes(32).toString('hex');

        await User.createUser(name, email, password, language, token);

        await sendVerificationEmail (email, token);
        
        res.status(201).json({ message: 'Check your email to verify your account!'})
    } catch (err) {
        console.error('Registration Error:', err);
        res.status(500).json({success: false, message: 'Something went wrong during registration.', error: err.message})
    }
}

exports.verifyEmail = async (req, res) => {
    try {
        const {token} = req.params;
        console.log('Token received from link:', token);
        
        const foundUser = await User.getUserByToken(token);
        console.log('User found in DB:');
        
        if (!foundUser) {
            return res.status(400).send('Invalid or expired verification link.')
        }

        await User.markAsVerifiedUser(foundUser.id);
        res.redirect('/auth/login')

    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error during verification.')
    }
};

exports.loginUser= async (req, res) => {
    try{
        const { email, password} = req.body;
        const user = await User.getUsersByEmail(email);

        if(!user  || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({message: 'Invalid email or password'});
        }

        if (user.is_verified === 0) {
            return res.status(403).json({ message: 'Please verify your email before logging in.' })
        }

        const token = jwt.sign({id: user.id},
            process.env.JWT_SECRET, 
            {expiresIn: '1h'}
        );

        res.status(200).json({
            message: 'Login Successful',
            token: token
        });


        /*const isMatch = await bcrypt.compare(password, user.password);
            if (isMatch) {
                res.send(`Welcome back, ${user.name}!`)
            } else {
                res.status(401).send('Inavalid password.');
            }*/
    } catch (err) {
        res.status(500).send('server error: ' + err.message)
    }
};


exports.forgotPassword = async (req, res) => {
    try{
        const {email} = req.body;
        const user = await user.getUsersByEmail(email)

        if(!user) return res.status(400).json({message: 'User not found'})

        const token = crypto.randomBytes.toString('hex');
        const expiry = new Date(Date.now() + 3600000);

        await User.setResetToken(email, token, expiry);

        await sendResetEmail(email, token);

        res.json({
            message: 'Password reset link sent to your email!'
        })
    } catch (err) {
        res.status(500).json({error: err.message})
    }
} 

exports.resetPassword = async (req, res) => {
    try {
        const {token} = req.params;
        const {password} = req.body;

        const user = await User.getUsersByResetToken(token);
            if(!user) return res.status(400).json({message: 'Token invalid or expired'})
        
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt)

        await User.updatePassword(user.id, hashedPassword);

        res.json({message: 'Password updated successully!'})
    } catch (err) {
        res.status(500).json({error: err.message})
    }
}