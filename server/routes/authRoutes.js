const express = require('express');
const router = express.Router();

// 1. Import Controller (Fixes: authController is not defined)
const authController = require('../controllers/authController');

// 2. Import Middleware (Fixes: authMiddleware is not defined)
const authMiddleware = require('../middleware/authMiddleware');

// --- Routes ---

// Public Routes (no auth required)
router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/verify-otp', authController.verifyOTP);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
// Refresh token: accepts body { refreshToken }, no Authorization header needed
router.post('/refresh-token', authController.refreshToken);

// Protected Routes (require valid access JWT)
router.post('/logout', authMiddleware, authController.logoutUser);
router.post('/fcm-token', authMiddleware, authController.saveFcmToken);
router.get('/search', authMiddleware, authController.searchUser);
router.put('/e2e-key', authMiddleware, authController.updateE2EPublicKey);
router.get('/my-e2e-keys', authMiddleware, authController.getMyE2EKeys);
router.get('/users/:userId/e2e-key', authMiddleware, authController.getUserE2EPublicKey);
router.put('/update-profile', authMiddleware, authController.updateProfile);
// Recovery PIN backup (called once after first login)
router.post('/e2e-pin-backup', authMiddleware, authController.setRecoveryPinBackup);

module.exports = router;