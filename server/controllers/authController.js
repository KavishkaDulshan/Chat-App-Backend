const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

exports.register = async (req, res) => {
    try {
        const { username, email, password } = req.body;
        if (!username || !email || !password) return res.status(400).json({ error: "All fields are required" });

        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ error: "User already exists" });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({ username, email, password: hashedPassword });
        await newUser.save();

        res.status(201).json({ message: "User created successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: "Invalid data format" });

        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ error: "User not found" });

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