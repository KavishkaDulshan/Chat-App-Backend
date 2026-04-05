const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true }, // NEW
    password: { type: String, required: true },               // NEW
    is_online: { type: Boolean, default: false },
    fcm_tokens: [{ type: String }],

    isVerified: { type: Boolean, default: false }, // false by default
    otp: { type: String },                         // Stores the 6-digit code
    otpExpires: { type: Date },

    // Public identity key used by clients for E2EE key agreement.
    e2e_public_key: { type: String, default: '' },
    e2e_key_version: { type: Number, default: 1 },

    profile_pic: { type: String, default: "" } // Stores Cloudinary URL

}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);