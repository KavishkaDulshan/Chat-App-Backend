const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true }, // NEW
    password: { type: String, required: true },               // NEW
    is_online: { type: Boolean, default: false },
    fcm_tokens: [{ type: String }],

    isVerified: { type: Boolean, default: false }, // false by default
    otp: { type: String },                         // Stores the 6-digit code
    otpExpires: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);