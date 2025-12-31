const express = require('express');
const router = express.Router(); // <--- FIXED: Removed the extra '.express'
const { register, login, searchUser } = require('../controllers/authController');
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again in 15 minutes'
});

router.post('/register', limiter, register);
router.post('/login', limiter, login);
router.get('/search', searchUser);

module.exports = router;