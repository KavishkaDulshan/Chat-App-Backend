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

    refreshTokens: [{
        tokenHash: { type: String, required: true },
        expiresAt: { type: Date, required: true }
    }],

    e2e_public_key: { type: String, default: '' },
    e2e_private_key: { type: String, default: '' },
    e2e_server_backup_key: { type: String, default: '' },
    e2e_pin_backup_key: { type: String, default: '' },
    e2e_key_version: { type: Number, default: 1 },

    profile_pic: { type: String, default: "" },

    settings: {
        showNotificationPreview: { type: Boolean, default: false }
    }

}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);
