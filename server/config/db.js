const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
    const mongoUri = process.env.MONGO_URI;

    if (!mongoUri) {
        logger.error('MONGO_URI is missing');
        process.exit(1);
    }

    if (mongoUri.includes('<db_password>')) {
        logger.error('MONGO_URI still contains <db_password>');
        process.exit(1);
    }

    const connectWithRetry = async () => {
        try {
            await mongoose.connect(mongoUri);
            logger.info('MongoDB connected');
        } catch (err) {
            logger.error('MongoDB connection error', { error: err.message });
            setTimeout(connectWithRetry, 5000);
        }
    };

    connectWithRetry();
};

module.exports = connectDB;
