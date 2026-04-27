const mongoose = require('mongoose');

const connectDB = async () => {
    const mongoUri = process.env.MONGO_URI;

    if (!mongoUri) {
        console.error('❌ MONGO_URI is missing. Set your MongoDB Atlas URI in server/.env.');
        process.exit(1);
    }

    if (mongoUri.includes('<db_password>')) {
        console.error('❌ MONGO_URI still contains <db_password>. Replace it with your real Atlas password.');
        process.exit(1);
    }

    const connectWithRetry = async () => {
        try {
            await mongoose.connect(mongoUri);
            console.log('✅ MongoDB Connected!');
        } catch (err) {
            console.error('❌ MongoDB Connection Error:', err.message);
            console.log('⏳ Retrying in 5 seconds...');
            setTimeout(connectWithRetry, 5000); // Retry after 5 seconds
        }
    };

    connectWithRetry();
};

module.exports = connectDB;
