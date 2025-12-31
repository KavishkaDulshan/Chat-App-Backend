const express = require('express');
const router = express.Router();
const { getConversations } = require('../controllers/chatController');

router.get('/conversations/:userId', getConversations);

module.exports = router;