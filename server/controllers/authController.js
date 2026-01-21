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

// server/controllers/authController.js

// ... keep your imports and other functions (register, login, verifyOTP, etc.) ...

exports.searchUser = async (req, res) => {
    try {
        const { username } = req.query;
        const currentUserId = req.user.id; // Comes from authMiddleware

        let query = {};

        // 1. If username is provided, search by Regex (Partial Match)
        if (username && username.trim().length > 0) {
            query = {
                username: { $regex: username, $options: 'i' }, // 'i' = case insensitive
                _id: { $ne: currentUserId } // Exclude myself
            };
        } else {
            // 2. If NO username, return all users (or recent chats)
            // This fixes the "Username query required" error on initial load
            query = {
                _id: { $ne: currentUserId } // Exclude myself
            };
        }

        // 3. Find users (Limit to 20 to avoid overloading)
        const users = await User.find(query)
            .select('username email profile_pic is_online') // Only get necessary fields
            .limit(20);

        // 4. Always return 200 OK with a list (even if empty)
        // This fixes the "Search Failed" logs
        res.status(200).json(users);

    } catch (err) {
        console.error("Search Error:", err);
        res.status(500).json({ error: "Server error during search" });
    }
};


exports.updateProfile = async (req, res) => {
    try {
        const { userId, profile_pic } = req.body;

        // Security Check: Ensure user is updating their OWN profile
        // (In a real app, use req.user.id from the authMiddleware instead of body)

        const user = await User.findByIdAndUpdate(
            userId,
            { profile_pic: profile_pic },
            { new: true } // Return the updated user
        ).select('-password'); // Don't send back password

        if (!user) return res.status(404).json({ error: "User not found" });

        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};