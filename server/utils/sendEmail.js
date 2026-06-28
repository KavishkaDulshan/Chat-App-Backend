const nodemailer = require('nodemailer');
const logger = require('./logger');

const sendEmail = async (email, otp) => {
    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Your Chat App Verification Code',
            text: `Your verification code is: ${otp}. It expires in 10 minutes.`
        };

        await transporter.sendMail(mailOptions);
        logger.info('Email sent', { email });
    } catch (error) {
        logger.error('Email error', { error: error.message });
        throw new Error("Email could not be sent");
    }
};

module.exports = sendEmail;