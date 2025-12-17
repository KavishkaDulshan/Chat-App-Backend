const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
    conversation_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    sender_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true },
    // FIX: Add this field so the DB saves 'image' or 'text'
    type: { type: String, enum: ['text', 'image'], default: 'text' }
}, { timestamps: true });

module.exports = mongoose.model('Message', MessageSchema);