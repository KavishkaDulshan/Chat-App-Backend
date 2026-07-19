const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/verify-otp', authController.verifyOTP);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.post('/refresh-token', authController.refreshToken);

router.post('/logout', authMiddleware, authController.logoutUser);
router.post('/fcm-token', authMiddleware, authController.saveFcmToken);
router.get('/search', authMiddleware, authController.searchUser);
router.put('/e2e-key', authMiddleware, authController.updateE2EPublicKey);
router.get('/my-e2e-keys', authMiddleware, authController.getMyE2EKeys);
router.get('/users/:userId/e2e-key', authMiddleware, authController.getUserE2EPublicKey);
router.put('/update-profile', authMiddleware, authController.updateProfile);
router.post('/e2e-pin-backup', authMiddleware, authController.setRecoveryPinBackup);

router.get('/users/:userId/brief', authMiddleware, authController.getUserBrief);

module.exports = router;
