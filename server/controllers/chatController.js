const Conversation = require('../models/Conversation');
const User = require('../models/User');
const Message = require('../models/Message');
const { decrypt } = require('../utils/crypto');

exports.getConversations = async (req, res) => {
    try {
        const { userId } = req.params;
        const conversations = await Conversation.find({ participants: userId }).sort({ updatedAt: -1 });

        const populatedConversations = await Promise.all(conversations.map(async (conv) => {
            const otherUserId = conv.participants.find(id => id.toString() !== userId);
            const otherUser = await User.findById(otherUserId).select('username email is_online profile_pic');

            // ✅ CRITICAL FIX: If the other user no longer exists, skip this conversation
            // This prevents the frontend from crashing when it tries to read properties of a null user
            if (!otherUser) {
                return null;
            }

            // 2. Fetch the actual latest message to check status
            const lastMsgDoc = await Message.findOne({ conversation_id: conv._id })
                .sort({ createdAt: -1 });

            let preview = "Start of conversation";
            let isDeleted = false;

            if (lastMsgDoc) {
                isDeleted = lastMsgDoc.isDeleted; // Get deleted status
                preview = lastMsgDoc.content;

                // Decrypt if it's a real message and not deleted
                if (!isDeleted && preview && !preview.includes('📷 Image') && !preview.includes('Start of conversation')) {
                    // Only attempt decrypt if it looks like encrypted text (no spaces usually) or based on your logic
                    // Adding a safe check or try/catch is recommended
                    try {
                        preview = decrypt(preview);
                    } catch (e) {
                        // Keep original if decrypt fails (e.g. system message)
                    }
                }
            }

            return {
                id: conv._id,
                otherUser: otherUser,
                lastMessage: preview,
                lastMessageIsDeleted: isDeleted, // 3. Send the flag
                updatedAt: conv.updatedAt
            };
        }));

        // ✅ CRITICAL FIX: Filter out the nulls (broken/ghost chats) from the final array
        const validConversations = populatedConversations.filter(c => c !== null);

        res.json(validConversations);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};