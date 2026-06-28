const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const FIREBASE_ENV_VAR = process.env.FIREBASE_SERVICE_ACCOUNT;

let serviceAccount;

try {
    if (FIREBASE_ENV_VAR) {
        logger.info('Loading Firebase config from environment variable');
        serviceAccount = JSON.parse(FIREBASE_ENV_VAR);
    } else {
        const serviceAccountPath = path.join(__dirname, 'service-account.json');

        if (fs.existsSync(serviceAccountPath)) {
            logger.info('Loading Firebase config from local file');
            serviceAccount = require(serviceAccountPath);
        } else {
            throw new Error("No Firebase credentials found! Set FIREBASE_SERVICE_ACCOUNT or add service-account.json");
        }
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    logger.info('Firebase Admin initialized');

} catch (error) {
    logger.error('Firebase init error', { error: error.message });
    if (process.env.NODE_ENV === 'production') {
        process.exit(1);
    }
}

module.exports = admin;