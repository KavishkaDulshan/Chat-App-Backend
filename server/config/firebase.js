const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// 1. Define the specific environment variable name
const FIREBASE_ENV_VAR = process.env.FIREBASE_SERVICE_ACCOUNT;

let serviceAccount;

try {
    // SCENARIO A: PRODUCTION (Render/Cloud)
    // If the Environment Variable exists, parse it directly.
    if (FIREBASE_ENV_VAR) {
        console.log("🔥 Loading Firebase config from Environment Variable...");
        serviceAccount = JSON.parse(FIREBASE_ENV_VAR);
    }
    // SCENARIO B: DEVELOPMENT (Local)
    // If env var is missing, look for the file.
    else {
        const serviceAccountPath = path.join(__dirname, 'service-account.json');

        if (fs.existsSync(serviceAccountPath)) {
            console.log("📂 Loading Firebase config from local file...");
            serviceAccount = require(serviceAccountPath);
        } else {
            throw new Error("No Firebase credentials found! Set FIREBASE_SERVICE_ACCOUNT or add service-account.json");
        }
    }

    // Initialize Admin SDK
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("🔥 Firebase Admin Initialized Successfully");

} catch (error) {
    console.error("❌ Firebase Init Error:", error.message);
    // In production, we want the app to crash if this fails, so we know something is wrong.
    if (process.env.NODE_ENV === 'production') {
        process.exit(1);
    }
}

module.exports = admin;