const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sendEmail = require('../utils/sendEmail'); // <--- Import this
const { deleteBlob } = require('../config/azureStorage');


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

        res.json({
            message: "Verification successful",
            token,
            user: {
                _id: user._id,
                username: user.username,
                email: user.email,
                profile_pic: user.profile_pic,
                e2e_public_key: user.e2e_public_key,
                e2e_key_version: user.e2e_key_version
            }
        });

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

        res.json({
            token,
            user: {
                _id: user._id,
                username: user.username,
                email: user.email,
                profile_pic: user.profile_pic,
                e2e_public_key: user.e2e_public_key,
                e2e_key_version: user.e2e_key_version
            }
        });
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

        // SEC-4: Require a minimum query length to prevent user enumeration
        if (!username || username.trim().length < 2) {
            return res.status(200).json([]);
        }

        // Sanitize regex input to prevent ReDoS
        const sanitized = username.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const query = {
            username: { $regex: sanitized, $options: 'i' },
            _id: { $ne: currentUserId } // Exclude myself
        };

        // Find users (Limit to 20 to avoid overloading)
        const users = await User.find(query)
            .select('username email profile_pic is_online e2e_public_key e2e_key_version')
            .limit(20);

        res.status(200).json(users);

    } catch (err) {
        console.error("Search Error:", err);
        res.status(500).json({ error: "Server error during search" });
    }
};


exports.updateProfile = async (req, res) => {
    try {
        const { profile_pic } = req.body;
        const userId = req.user.id; // Secure: use authenticated user's ID from JWT

        // Delete old profile pic blob from Azure (if it exists)
        const existingUser = await User.findById(userId);
        if (existingUser && existingUser.profile_pic) {
            await deleteBlob(existingUser.profile_pic);
        }

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

exports.updateE2EPublicKey = async (req, res) => {
    try {
        const userId = req.user.id;
        const { publicKey, privateKey, keyVersion } = req.body;

        if (!publicKey || typeof publicKey !== 'string') {
            return res.status(400).json({ error: 'publicKey is required' });
        }

        const updateFields = {
            e2e_public_key: publicKey,
            e2e_key_version: Number.isInteger(keyVersion) ? keyVersion : 1
        };

        // Also store the private key if the client sends it (cross-device backup)
        if (privateKey && typeof privateKey === 'string') {
            updateFields.e2e_private_key = privateKey;
        }

        const user = await User.findByIdAndUpdate(
            userId,
            updateFields,
            { new: true }
        ).select('_id e2e_public_key e2e_key_version');

        if (!user) return res.status(404).json({ error: 'User not found' });

        res.status(200).json({
            userId: user._id,
            e2e_public_key: user.e2e_public_key,
            e2e_key_version: user.e2e_key_version
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.getUserE2EPublicKey = async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await User.findById(userId).select('_id e2e_public_key e2e_key_version');

        if (!user) return res.status(404).json({ error: 'User not found' });

        res.status(200).json({
            userId: user._id,
            e2e_public_key: user.e2e_public_key || '',
            e2e_key_version: user.e2e_key_version || 1
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// NEW: Return the authenticated user's FULL key pair (public + private)
// so any device/platform can restore the same identity and decrypt old messages.
exports.getMyE2EKeys = async (req, res) => {
    try {
        const userId = req.user.id;
        const user = await User.findById(userId).select('e2e_public_key e2e_private_key e2e_key_version');

        if (!user) return res.status(404).json({ error: 'User not found' });

        res.status(200).json({
            e2e_public_key: user.e2e_public_key || '',
            e2e_private_key: user.e2e_private_key || '',
            e2e_key_version: user.e2e_key_version || 1
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};