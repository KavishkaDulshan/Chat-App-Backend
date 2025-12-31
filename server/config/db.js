const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        const mongoUri = process.env.MONGO_URI || 'mongodb://mongo:27017/chat-app';
        await mongoose.connect(mongoUri);
        console.log('✅ MongoDB Connected!');
    } catch (err) {
        console.error('❌ MongoDB Connection Error:', err);
        process.exit(1);
    }
};

module.exports = connectDB;