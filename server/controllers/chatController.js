const Conversation = require('../models/Conversation');
const User = require('../models/User');
const { decrypt } = require('../utils/crypto');

exports.getConversations = async (req, res) => {
    try {
        const { userId } = req.params;
        const conversations = await Conversation.find({ participants: userId }).sort({ updatedAt: -1 });

        const populatedConversations = await Promise.all(conversations.map(async (conv) => {
            const otherUserId = conv.participants.find(id => id.toString() !== userId);
            const otherUser = await User.findById(otherUserId).select('username email is_online');

            // Decrypt Preview
            let preview = conv.last_message;
            if (preview && !preview.includes('Start of conversation') && !preview.includes('📷 Image')) {
                preview = decrypt(preview);
            }

            return {
                id: conv._id,
                otherUser: otherUser,
                lastMessage: preview,
                updatedAt: conv.updatedAt
            };
        }));

        res.json(populatedConversations);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};