const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
    conversation_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    sender_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true },
    type: { type: String, enum: ['text', 'image'], default: 'text' },
    isDeleted: { type: Boolean, default: false },

    // NEW: Status Field
    status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' }
}, { timestamps: true });

module.exports = mongoose.model('Message', MessageSchema);