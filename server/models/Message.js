const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
    conversation_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    sender_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true },
    type: { type: String, enum: ['text', 'image'], default: 'text' },

    // NEW FIELD: Tracks if a message is deleted
    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Message', MessageSchema);