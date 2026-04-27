const Conversation = require('../models/Conversation');
const User = require('../models/User');
const Message = require('../models/Message');
const { decrypt } = require('../utils/crypto');

const isE2EEnvelope = (text) => typeof text === 'string' && text.startsWith('e2e:v1:');

exports.getConversations = async (req, res) => {
    try {
        const { userId } = req.params;
        const conversations = await Conversation.find({ participants: userId }).sort({ updatedAt: -1 });

        const populatedConversations = await Promise.all(conversations.map(async (conv) => {
            const otherUserId = conv.participants.find(id => id.toString() !== userId);
            const otherUser = await User.findById(otherUserId).select('username email is_online profile_pic e2e_public_key e2e_key_version');

            // BUG-2: If the other user no longer exists, clean up orphaned data
            if (!otherUser) {
                // Fire-and-forget: delete orphaned conversation and its messages
                Message.deleteMany({ conversation_id: conv._id }).catch(err =>
                    console.error('Ghost cleanup (messages) error:', err)
                );
                Conversation.findByIdAndDelete(conv._id).catch(err =>
                    console.error('Ghost cleanup (conversation) error:', err)
                );
                return null;
            }

            // 2. Fetch the actual latest message to check status
            const lastMsgDoc = await Message.findOne({ conversation_id: conv._id })
                .sort({ createdAt: -1 });

            let preview = "Start of conversation";
            let isDeleted = false;

            let lastMessageType = 'text';
            if (lastMsgDoc) {
                isDeleted = lastMsgDoc.isDeleted; // Get deleted status
                preview = lastMsgDoc.content;
                lastMessageType = lastMsgDoc.type || 'text';

                // ✅ E2E messages: return ciphertext as-is so client can decrypt
                // Do NOT replace with 'Encrypted message' — the client will handle decryption
                if (!isDeleted && lastMessageType === 'text' && isE2EEnvelope(preview)) {
                    // Keep the raw E2E ciphertext — client decrypts it
                }
                // Decrypt server-side AES-CBC encrypted messages (non-E2E)
                else if (!isDeleted && preview && !isE2EEnvelope(preview) && !preview.includes('📷 Image') && !preview.includes('Start of conversation')) {
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
                lastMessageType: lastMessageType,     // ✅ NEW: helps client identify E2E messages
                lastMessageIsDeleted: isDeleted,
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