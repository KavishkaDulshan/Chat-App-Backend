const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sendEmail = require('../utils/sendEmail');
const crypto = require('crypto');
const logger = require('../utils/logger');

const MASTER_KEY_SECRET = process.env.E2E_MASTER_KEY || 'default_master_key_123_ensure_32_bytes_length';
const SERVER_MASTER_KEY = crypto.scryptSync(MASTER_KEY_SECRET, 'server_salt', 32);

const REFRESH_TOKEN_EXPIRY_DAYS = 30;
const ACCESS_TOKEN_EXPIRY = '15m';

const generateRefreshToken = () => crypto.randomBytes(64).toString('hex');

const hashRefreshToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const issueTokenPair = async (user) => {
    const accessToken = jwt.sign(
        { id: user._id, username: user.username },
        process.env.JWT_SECRET,
        { expiresIn: ACCESS_TOKEN_EXPIRY }
    );
    const rawRefreshToken = generateRefreshToken();
    const tokenHash = hashRefreshToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    await User.findByIdAndUpdate(user._id, {
        $push: { refreshTokens: { tokenHash, expiresAt } }
    });

    return { accessToken, rawRefreshToken };
};

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

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpires = Date.now() + 10 * 60 * 1000;

        const newUser = new User({
            username,
            email,
            password: hashedPassword,
            otp: otp,
            otpExpires: otpExpires,
            isVerified: false
        });
        await newUser.save();

        await sendEmail(email, otp);

        res.status(201).json({ message: "OTP sent to email. Please verify." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.verifyOTP = async (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) return res.status(400).json({ error: "Email and OTP required" });

        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ error: "User not found" });

        if (user.otp !== otp) return res.status(400).json({ error: "Invalid OTP" });
        if (user.otpExpires < Date.now()) return res.status(400).json({ error: "OTP has expired" });

        user.isVerified = true;
        user.otp = undefined;
        user.otpExpires = undefined;
        await user.save();

        const { accessToken, rawRefreshToken } = await issueTokenPair(user);

        res.json({
            message: "Verification successful",
            token: accessToken,
            refreshToken: rawRefreshToken,
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

exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: "Invalid data format" });

        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ error: "User not found" });

        if (!user.isVerified) {
            return res.status(400).json({ error: "Please verify your email first" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

        await User.findByIdAndUpdate(user._id, {
            $pull: { refreshTokens: { expiresAt: { $lt: new Date() } } }
        });

        const { accessToken, rawRefreshToken } = await issueTokenPair(user);

        res.json({
            token: accessToken,
            refreshToken: rawRefreshToken,
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

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpires = Date.now() + 10 * 60 * 1000;

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
                            logger.info('E2E key recovered and re-encrypted', { email: user.email });
                        }
                    }
                }
            } catch (err) {
                logger.error('E2EE recovery failed', { email: user.email, error: err.message });
            }
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        user.password = hashedPassword;
        user.otp = undefined;
        user.otpExpires = undefined;
        user.refreshTokens = [];
        await user.save();

        res.status(200).json({ message: "Password reset successful" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.refreshToken = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

        const tokenHash = hashRefreshToken(refreshToken);
        const user = await User.findOne({ 'refreshTokens.tokenHash': tokenHash });

        if (!user) {
            return res.status(401).json({ error: 'Invalid refresh token' });
        }

        const tokenEntry = user.refreshTokens.find(t => t.tokenHash === tokenHash);

        if (!tokenEntry || tokenEntry.expiresAt < new Date()) {
            await User.findByIdAndUpdate(user._id, {
                $pull: { refreshTokens: { tokenHash } }
            });
            return res.status(401).json({ error: 'Refresh token expired, please log in again' });
        }

        await User.findByIdAndUpdate(user._id, {
            $pull: { refreshTokens: { tokenHash } }
        });

        const { accessToken, rawRefreshToken: newRawRefreshToken } = await issueTokenPair(user);

        res.json({
            token: accessToken,
            refreshToken: newRawRefreshToken
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.logoutUser = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (refreshToken) {
            const tokenHash = hashRefreshToken(refreshToken);
            await User.findByIdAndUpdate(req.user.id, {
                $pull: { refreshTokens: { tokenHash } }
            });
        }
        res.status(200).json({ message: 'Logged out successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.setRecoveryPinBackup = async (req, res) => {
    try {
        const userId = req.user.id;
        const { pin } = req.body;

        if (!pin || typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
            return res.status(400).json({ error: 'A 6-digit PIN is required' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const pinBackupKeyB64 = crypto.pbkdf2Sync(pin, userId.toString(), 100000, 32, 'sha256').toString('base64');

        if (user.e2e_private_key && user.e2e_server_backup_key) {
            const oldBackupKeyB64 = decryptEscrowKey(user.e2e_server_backup_key);
            if (oldBackupKeyB64) {
                const rawPrivateKeyB64 = decryptFlutterE2E(user.e2e_private_key, oldBackupKeyB64);
                if (rawPrivateKeyB64) {
                    const pinEncryptedPrivKey = encryptFlutterE2E(rawPrivateKeyB64, pinBackupKeyB64);
                    if (pinEncryptedPrivKey) {
                        await User.findByIdAndUpdate(userId, {
                            e2e_pin_backup_key: encryptEscrowKey(pinBackupKeyB64)
                        });
                        return res.status(200).json({ message: 'Recovery PIN backup set successfully' });
                    }
                }
            }
        }

        await User.findByIdAndUpdate(userId, {
            e2e_pin_backup_key: encryptEscrowKey(pinBackupKeyB64)
        });
        res.status(200).json({ message: 'Recovery PIN registered' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};


exports.saveFcmToken = async (req, res) => {
    try {
        const { token } = req.body;
        const userId = req.user.id;

        if (!token) return res.status(400).json({ message: "Token required" });

        await User.findByIdAndUpdate(userId, {
            $addToSet: { fcm_tokens: token }
        });

        res.status(200).json({ message: "Token saved" });
    } catch (err) {
        logger.error('Save FCM token error', { error: err.message });
        res.status(500).json({ message: "Server error" });
    }
};

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

        const results = users.map((u) => ({
            _id: u._id,
            username: u.username,
            email: u.email,
            profile_pic: u.profile_pic,
            is_online: u.is_online,
            e2e_public_key: u.e2e_public_key,
            e2e_key_version: u.e2e_key_version,
            contactStatus: 'none',
        }));

        res.status(200).json(results);

    } catch (err) {
        logger.error('Search error', { error: err.message });
        res.status(500).json({ error: "Server error during search" });
    }
};

exports.updateProfile = async (req, res) => {
    try {
        const { profile_pic, username, showNotificationPreview } = req.body;
        const userId = req.user.id;

        const updateData = {};
        if (profile_pic) updateData.profile_pic = profile_pic;
        if (username) updateData.username = username;
        if (typeof showNotificationPreview === 'boolean') {
            updateData['settings.showNotificationPreview'] = showNotificationPreview;
        }

        const user = await User.findByIdAndUpdate(
            userId,
            updateData,
            { new: true }
        ).select('-password');

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

        if (privateKey && typeof privateKey === 'string') {
            updateFields.e2e_private_key = privateKey;
        }

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

exports.getUserBrief = async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await User.findById(userId).select('username profile_pic is_online email');

        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({
            _id: user._id,
            username: user.username,
            profile_pic: user.profile_pic,
            is_online: user.is_online,
            email: user.email,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
