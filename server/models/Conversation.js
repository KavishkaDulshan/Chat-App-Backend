const mongoose = require('mongoose');

const ConversationSchema = new mongoose.Schema({
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    last_message: { type: String }, // Helps show preview text in the list
}, { timestamps: true });

ConversationSchema.index({ participants: 1 });
module.exports = mongoose.model('Conversation', ConversationSchema);