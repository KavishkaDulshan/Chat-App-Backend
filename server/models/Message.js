// server/models/Message.js
const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
    conversation_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    sender_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true },

    // ✅ ADD 'audio' here
    type: { type: String, enum: ['text', 'image', 'audio'], default: 'text' },

    // ✅ ADD duration for audio messages (in seconds)
    duration: { type: Number, default: 0 },

    isDeleted: { type: Boolean, default: false },
    status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' }
}, { timestamps: true });

module.exports = mongoose.model('Message', MessageSchema);