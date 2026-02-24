const mongoose = require('mongoose');

const connectDB = async () => {
    const mongoUri = process.env.MONGO_URI || 'mongodb://mongo:27017/chat-app';

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