const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sendEmail = require('../utils/sendEmail');
const { deleteBlob } = require('../config/azureStorage');
const { getContactStatusHelper } = require('./contactController');
const crypto = require('crypto');

const MASTER_KEY_SECRET = process.env.E2E_MASTER_KEY || 'default_master_key_123_ensure_32_bytes_length';
const SERVER_MASTER_KEY = crypto.scryptSync(MASTER_KEY_SECRET, 'server_salt', 32);

const encryptEscrowKey = (backupKeyB64) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', SERVER_MASTER_KEY, iv);
    let cipherText = cipher.update(backupKeyB64, 'utf8');
    cipherText = Buffer.concat([cipherText, cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
        iv: iv.toString('base64'),
        c: cipherText.toString('base64'),
        t: tag.toString('base64')
    });
};

const decryptEscrowKey = (encryptedEscrow) => {
    try {
        const { iv, c, t } = JSON.parse(encryptedEscrow);
        const decipher = crypto.createDecipheriv('aes-256-gcm', SERVER_MASTER_KEY, Buffer.from(iv, 'base64'));
        decipher.setAuthTag(Buffer.from(t, 'base64'));
        let clearText = decipher.update(Buffer.from(c, 'base64'), null, 'utf8');
        clearText += decipher.final('utf8');
        return clearText;
    } catch (e) {
        return null;
    }
};

const decryptFlutterE2E = (encryptedPayload, backupKeyB64) => {
    try {
        if (!encryptedPayload.startsWith('aes-gcm:v1:')) return encryptedPayload;
        const encodedPart = encryptedPayload.substring('aes-gcm:v1:'.length);
        const decoded = Buffer.from(encodedPart, 'base64').toString('utf8');
        const map = JSON.parse(decoded);
        if (map.v !== 1) return null;

        const nonce = Buffer.from(map.n, 'base64');
        const cipherText = Buffer.from(map.c, 'base64');
        const tag = Buffer.from(map.t, 'base64');
        const key = Buffer.from(backupKeyB64, 'base64');

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAuthTag(tag);
        let clearText = decipher.update(cipherText, null, 'utf8');
        clearText += decipher.final('utf8');
        return clearText;
    } catch (e) {
        return null;
    }
};

const encryptFlutterE2E = (rawPrivateKeyB64, backupKeyB64) => {
    try {
        const key = Buffer.from(backupKeyB64, 'base64');
        const nonce = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
        let cipherText = cipher.update(rawPrivateKeyB64, 'utf8');
        cipherText = Buffer.concat([cipherText, cipher.final()]);
        const tag = cipher.getAuthTag();

        const payload = {
            v: 1,
            n: nonce.toString('base64'),
            c: cipherText.toString('base64'),
            t: tag.toString('base64')
        };
        return 'aes-gcm:v1:' + Buffer.from(JSON.stringify(payload)).toString('base64');
    } catch (e) {
        return null;
    }
};

const deriveBackupKeyB64 = (password, salt) => {
    return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('base64');
};


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
                e2e_key_version: user.e2e_key_version,
                settings: user.settings
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
                e2e_key_version: user.e2e_key_version,
                settings: user.settings
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: "Email is required" });

        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ error: "User not found" });

        // Generate 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpires = Date.now() + 10 * 60 * 1000; // 10 Minutes from now

        user.otp = otp;
        user.otpExpires = otpExpires;
        await user.save();

        await sendEmail(email, otp);

        res.status(200).json({ message: "Password reset OTP sent to email." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.resetPassword = async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;
        if (!email || !otp || !newPassword) return res.status(400).json({ error: "All fields are required" });

        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ error: "User not found" });

        if (user.otp !== otp) return res.status(400).json({ error: "Invalid OTP" });
        if (user.otpExpires < Date.now()) return res.status(400).json({ error: "OTP has expired" });

        // ==============================================================
        // E2EE RECOVERY: Re-encrypt the user's private key with the new password
        // ==============================================================
        if (user.e2e_private_key && user.e2e_server_backup_key) {
            try {
                const oldBackupKeyB64 = decryptEscrowKey(user.e2e_server_backup_key);
                if (oldBackupKeyB64) {
                    const rawPrivateKeyB64 = decryptFlutterE2E(user.e2e_private_key, oldBackupKeyB64);
                    if (rawPrivateKeyB64) {
                        const newBackupKeyB64 = deriveBackupKeyB64(newPassword, user.email);
                        const newEncryptedPrivateKey = encryptFlutterE2E(rawPrivateKeyB64, newBackupKeyB64);
                        if (newEncryptedPrivateKey) {
                            user.e2e_private_key = newEncryptedPrivateKey;
                            user.e2e_server_backup_key = encryptEscrowKey(newBackupKeyB64);
                            console.log(`Successfully recovered and re-encrypted E2E private key for ${user.email}`);
                        }
                    }
                }
            } catch (err) {
                console.error(`E2EE Recovery Failed for ${user.email}:`, err.message);
            }
        }
        // ==============================================================

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        user.password = hashedPassword;
        user.otp = undefined;
        user.otpExpires = undefined;
        await user.save();

        res.status(200).json({ message: "Password reset successful" });
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
        const currentUserId = req.user.id;

        if (!username || username.trim().length < 2) {
            return res.status(200).json([]);
        }

        const sanitized = username.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const query = {
            username: { $regex: sanitized, $options: 'i' },
            _id: { $ne: currentUserId }
        };

        const users = await User.find(query)
            .select('username email profile_pic is_online e2e_public_key e2e_key_version')
            .limit(20);

        // Attach contact status for each user
        const results = await Promise.all(users.map(async (u) => {
            const contactStatus = await getContactStatusHelper(currentUserId, u._id.toString());
            return {
                _id: u._id,
                username: u.username,
                email: u.email,
                profile_pic: u.profile_pic,
                is_online: u.is_online,
                e2e_public_key: u.e2e_public_key,
                e2e_key_version: u.e2e_key_version,
                contactStatus,
            };
        }));

        res.status(200).json(results);

    } catch (err) {
        console.error("Search Error:", err);
        res.status(500).json({ error: "Server error during search" });
    }
};

exports.updateProfile = async (req, res) => {
    try {
        const { profile_pic, username, showNotificationPreview } = req.body;
        const userId = req.user.id; // Secure: use authenticated user's ID from JWT

        const existingUser = await User.findById(userId);
        if (!existingUser) return res.status(404).json({ error: "User not found" });

        // Delete old profile pic blob from Azure (if it exists and is being replaced)
        if (profile_pic && existingUser.profile_pic && existingUser.profile_pic !== profile_pic) {
            await deleteBlob(existingUser.profile_pic);
        }

        const updateData = {};
        if (profile_pic) updateData.profile_pic = profile_pic;
        if (username) updateData.username = username;
        if (typeof showNotificationPreview === 'boolean') {
            updateData['settings.showNotificationPreview'] = showNotificationPreview;
        }

        const user = await User.findByIdAndUpdate(
            userId,
            updateData,
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
        const { publicKey, privateKey, backupKey, keyVersion } = req.body;

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

        // SERVER ESCROW: Save the backupKey encrypted by the server's master key
        if (backupKey && typeof backupKey === 'string') {
            updateFields.e2e_server_backup_key = encryptEscrowKey(backupKey);
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