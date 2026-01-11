// server/config/firebase.js
const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json'); // Ensure this file exists!

try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("🔥 Firebase Admin Initialized");
} catch (error) {
    console.error("❌ Firebase Admin Error:", error);
}

module.exports = admin;