const nodemailer = require('nodemailer');

const sendEmail = async (email, otp) => {
    try {
        // Create a Transporter (Using Gmail for testing)
        // For production, use SendGrid or a proper SMTP service
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER, // Add this to your .env file
                pass: process.env.EMAIL_PASS  // Add this to your .env file (App Password, not Login Password)
            }
        });

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Your Chat App Verification Code',
            text: `Your verification code is: ${otp}. It expires in 10 minutes.`
        };

        await transporter.sendMail(mailOptions);
        console.log(`📧 Email sent to ${email}`);
    } catch (error) {
        console.error("Email Error:", error);
        throw new Error("Email could not be sent");
    }
};

module.exports = sendEmail;