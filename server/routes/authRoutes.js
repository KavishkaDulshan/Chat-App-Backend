const express = require('express');
const router = express.Router();

// 1. Import Controller (Fixes: authController is not defined)
const authController = require('../controllers/authController');

// 2. Import Middleware (Fixes: authMiddleware is not defined)
const authMiddleware = require('../middleware/authMiddleware');

// --- Routes ---

// Public Routes
router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/verify-otp', authController.verifyOTP); // <--- ADD THIS LINE

// Protected Route for FCM (This is the one crashing)
router.post('/fcm-token', authMiddleware, authController.saveFcmToken);
router.get('/search', authMiddleware, authController.searchUser); // <--- ADD THIS LINE

module.exports = router;