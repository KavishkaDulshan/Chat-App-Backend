const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const {
    sendRequest,
    acceptRequest,
    declineRequest,
    getPendingRequests,
    getContactStatus,
} = require('../controllers/contactController');

// All contact routes require authentication
router.post('/request', authMiddleware, sendRequest);
router.post('/accept/:requestId', authMiddleware, acceptRequest);
router.post('/decline/:requestId', authMiddleware, declineRequest);
router.get('/pending', authMiddleware, getPendingRequests);
router.get('/status/:userId', authMiddleware, getContactStatus);

module.exports = router;
