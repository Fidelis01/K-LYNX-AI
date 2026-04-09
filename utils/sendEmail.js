const nodemailer = require('nodemailer');

const sendVerificationEmail = async (email, token) => {
    try{
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        const url = `http://localhost:5000/auth/verify/${token}`;
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Verify your K-LYNX AI account',
            html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; text-align: center; display: inline-block;">

                <h1 style="color: #070e6b;"> 
                Welcome to K-LYNX AI! 
                </h1>

                <p style="color: #070e6b;"> 
                Please click the link below to verify your email adress: 
                </p>

                <div style="margin: 30px 0;"> 
                <a href="${url}" style="background: #070e6b; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
                 Verify Email 
                </a> 

                </div>

                <p> If you didn't create this account, please ignore this email.</p>

                </div>

                `
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('Email sent successfully: ' + info.messageId);
        return true;
    } catch (error) {
        console.error('email utility error:', error.message);
        throw new Error('Email could not be sent. Please check your SMTP settings.')
    }
};

module.exports = sendVerificationEmail;