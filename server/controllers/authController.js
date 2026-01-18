const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sendEmail = require('../utils/sendEmail'); // <--- Import this


exports.register = async (req, res) => {
    try {
        const { username, email, password } = req.body;
        if (!username || !email || !password) return res.status(400).json({ error: "All fields are required" });

        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ error: "User already exists" });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Generate 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpires = Date.now() + 10 * 60 * 1000; // 10 Minutes from now

        const newUser = new User({
            username,
            email,
            password: hashedPassword,
            otp: otp,
            otpExpires: otpExpires,
            isVerified: false
        });
        await newUser.save();

        // Send Email (Non-blocking: we don't await strictly if we want speed, but good to ensure it sends)
        await sendEmail(email, otp);

        res.status(201).json({ message: "OTP sent to email. Please verify." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// 2. NEW FUNCTION: VERIFY OTP
exports.verifyOTP = async (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) return res.status(400).json({ error: "Email and OTP required" });

        const user = await User.findOne({ email });

        if (!user) return res.status(400).json({ error: "User not found" });

        // Check if OTP matches and is not expired
        if (user.otp !== otp) {
            return res.status(400).json({ error: "Invalid OTP" });
        }
        if (user.otpExpires < Date.now()) {
            return res.status(400).json({ error: "OTP has expired" });
        }

        // Success: Verify User & Clear OTP
        user.isVerified = true;
        user.otp = undefined;
        user.otpExpires = undefined;
        await user.save();

        // Optional: Log them in immediately
        const token = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET, {
            expiresIn: process.env.JWT_EXPIRES_IN || '30d'
        });

        res.json({ message: "Verification successful", token, user: { _id: user._id, username: user.username, email: user.email } });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// 3. MODIFIED LOGIN
exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;
        // ... (Keep existing validation) ... 
        if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: "Invalid data format" });

        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ error: "User not found" });

        // --- NEW CHECK: IS VERIFIED? ---
        if (!user.isVerified) {
            // Optional: Resend OTP logic could go here
            return res.status(400).json({ error: "Please verify your email first" });
        }
        // -------------------------------

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

        const token = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET, {
            expiresIn: process.env.JWT_EXPIRES_IN || '30d'
        });

        res.json({ token, user: { _id: user._id, username: user.username, email: user.email } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};


exports.searchUser = async (req, res) => {
    try {
        const { username } = req.query;
        if (!username || typeof username !== 'string') return res.json([]);

        const user = await User.findOne({
            username: { $regex: new RegExp(`^${username}$`, 'i') }
        }).select('-password');

        if (!user) return res.status(404).json({ error: "User not found" });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.saveFcmToken = async (req, res) => {
    try {
        const { token } = req.body;
        const userId = req.user.id; // Comes from auth middleware

        if (!token) return res.status(400).json({ message: "Token required" });

        // Add token to array using $addToSet (prevents duplicates)
        await User.findByIdAndUpdate(userId, {
            $addToSet: { fcm_tokens: token }
        });

        res.status(200).json({ message: "Token saved" });
    } catch (err) {
        console.error("Save Token Error:", err);
        res.status(500).json({ message: "Server error" });
    }
};

exports.searchUser = async (req, res) => {
    try {
        const { username } = req.query;

        if (!username) {
            return res.status(400).json({ message: "Username query required" });
        }

        // Find user by exact match (or use regex for partial match if you prefer)
        // We select only the fields we need (id, username) to protect privacy
        const user = await User.findOne({ username: username }).select('_id username is_online');

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        res.status(200).json(user);
    } catch (err) {
        console.error("Search Error:", err);
        res.status(500).json({ message: "Server error" });
    }
};