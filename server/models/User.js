const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    is_online: { type: Boolean, default: false },
    fcm_tokens: [{ type: String }],

    isVerified: { type: Boolean, default: false },
    otp: { type: String },
    otpExpires: { type: Date },

    // Refresh token rotation: each entry is a SHA-256 hashed token with an expiry.
    // On rotation, old token is deleted and a new one is inserted.
    // If a previously-used token is presented again, ALL tokens are revoked (theft detection).
    refreshTokens: [{
        tokenHash: { type: String, required: true },
        expiresAt: { type: Date, required: true }
    }],

    // E2EE key pair — stored on server as a cross-device backup.
    e2e_public_key: { type: String, default: '' },
    e2e_private_key: { type: String, default: '' },
    e2e_server_backup_key: { type: String, default: '' },  // password-derived backup (server-escrow encrypted)
    e2e_pin_backup_key: { type: String, default: '' },     // PIN-derived backup (server-escrow encrypted, independent of password)
    e2e_key_version: { type: Number, default: 1 },

    profile_pic: { type: String, default: "" },

    settings: {
        showNotificationPreview: { type: Boolean, default: false }
    }

}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);