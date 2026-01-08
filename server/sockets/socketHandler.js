const mongoose = require('mongoose');
const User = require('../models/User');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const { encrypt, decrypt } = require('../utils/crypto');
const socketAuth = require('../middleware/socketAuth');

// Helper: Find people who have chatted with this user
async function getActiveChatPartners(userId) {
    try {
        // 1. Find all conversations where this user is a participant
        const conversations = await Conversation.find({
            participants: userId
        }).select('participants');

        // 2. Extract unique IDs of the OTHER participants
        const partners = new Set();
        conversations.forEach(conv => {
            conv.participants.forEach(p => {
                const partnerId = p.toString();
                if (partnerId !== userId.toString()) {
                    partners.add(partnerId);
                }
            });
        });

        return Array.from(partners);
    } catch (err) {
        console.error("Error finding chat partners:", err);
        return [];
    }
}

module.exports = (io) => {
    io.use(socketAuth);

    io.on('connection', async (socket) => {
        const user = socket.data.user;
        const userId = user.id;

        // [NEW CODE]
        console.log(`✅ Secure Connection: ${user.username}`);
        socket.join(userId);
        User.findByIdAndUpdate(userId, { is_online: true }).exec();

        // Notify only relevant people
        const onlinePartners = await getActiveChatPartners(userId);
        onlinePartners.forEach(partnerId => {
            // Emit specifically to the partner's room (partnerId)
            io.to(partnerId).emit('user_status_change', { userId: userId, isOnline: true });
        });

        // 1. CHAT MESSAGE
        socket.on('chat_message', async (msgData) => {
            try {
                let { content, roomId, type = 'text' } = msgData;
                const senderId = socket.data.user.id;

                // === CRITICAL FIX: Resolve Composite ID to Real ObjectId ===
                // If roomId is NOT a valid MongoID (e.g. it's "user1_user2"), we resolve it.
                if (!mongoose.Types.ObjectId.isValid(roomId)) {
                    const parts = roomId.split('_');
                    if (parts.length === 2) {
                        // Find the real conversation for these users
                        let conv = await Conversation.findOne({ participants: { $all: parts } });
                        if (!conv) {
                            // Create if doesn't exist
                            conv = new Conversation({ participants: parts, last_message: 'Start' });
                            await conv.save();
                        }
                        roomId = conv._id.toString(); // SWAP to real ID
                    }
                }

                const encryptedContent = encrypt(content);

                const newMessage = new Message({
                    conversation_id: roomId, // Now using Valid ObjectId
                    sender_id: senderId,
                    content: encryptedContent,
                    type: type,
                    status: 'sent'
                });
                await newMessage.save();

                await Conversation.findByIdAndUpdate(roomId, {
                    last_message: type === 'image' ? '📷 Image' : encryptedContent,
                    updatedAt: Date.now()
                });

                // Send back with the REAL roomId so frontend can update
                io.to(roomId).emit('chat_message', {
                    _id: newMessage._id,
                    content: content,
                    sender_id: senderId,
                    sender_name: user.username,
                    timestamp: newMessage.createdAt,
                    roomId: roomId, // Send real ID
                    type: type,
                    isDeleted: false,
                    status: 'sent'
                });

            } catch (err) { console.error("Message Error:", err); }
        });

        // 2. JOIN PRIVATE CHAT (Loads History)
        socket.on('join_private_chat', async (otherUserId) => {
            try {
                const myUserId = socket.data.user.id;

                // Find or Create Conversation
                let conversation = await Conversation.findOne({
                    participants: { $all: [myUserId, otherUserId] }
                });

                if (!conversation) {
                    conversation = new Conversation({
                        participants: [myUserId, otherUserId],
                        last_message: 'Start of conversation'
                    });
                    await conversation.save();
                }

                const roomId = conversation._id.toString();

                // Load History
                const rawMessages = await Message.find({ conversation_id: roomId })
                    .sort({ createdAt: -1 })
                    .limit(50);
                const messages = rawMessages.reverse();

                const history = messages.map(m => ({
                    _id: m._id,
                    content: m.isDeleted ? "This message was deleted" : decrypt(m.content),
                    sender_id: m.sender_id,
                    sender_name: (m.sender_id.toString() === myUserId.toString()) ? 'Me' : 'Partner',
                    timestamp: m.createdAt,
                    roomId: roomId,
                    type: m.type || 'text',
                    isDeleted: m.isDeleted,
                    status: m.status
                }));

                // Join the Real Room ID
                socket.join(roomId);

                // Send Ready Event
                socket.emit('private_chat_ready', { roomId: roomId, history: history });

            } catch (err) { console.error("Join Chat Error:", err); }
        });

        // 3. READ RECEIPTS & DELETE (Standard Listeners)
        socket.on('conversation:read', async ({ roomId }) => {
            if (!mongoose.Types.ObjectId.isValid(roomId)) return; // Ignore invalid IDs
            try {
                const myUserId = socket.data.user.id;
                await Message.updateMany(
                    { conversation_id: roomId, sender_id: { $ne: myUserId }, status: { $ne: 'read' } },
                    { $set: { status: 'read' } }
                );
                io.to(roomId).emit('conversation:read_ack', { roomId, readerId: myUserId });
            } catch (err) { console.error(err); }
        });

        socket.on('message:delete', async ({ messageId, roomId }) => {
            try {
                const msg = await Message.findById(messageId);
                if (!msg || msg.sender_id.toString() !== socket.data.user.id) return;
                msg.isDeleted = true;
                await msg.save();
                io.to(roomId).emit('message:deleted', messageId);
            } catch (err) { console.error(err); }
        });

        socket.on('message:delivered', async ({ messageId, roomId }) => {
            try {
                const msg = await Message.findById(messageId);
                if (msg && msg.status === 'sent') {
                    msg.status = 'delivered';
                    await msg.save();
                    io.to(roomId).emit('message:status_update', { messageId, status: 'delivered', roomId });
                }
            } catch (err) { console.error(err); }
        });

        socket.on('typing', (roomId) => socket.broadcast.to(roomId).emit('display_typing', { username: socket.data.user.username, roomId }));
        socket.on('stop_typing', (roomId) => socket.broadcast.to(roomId).emit('hide_typing', { roomId }));

        // [NEW CODE]
        socket.on('disconnect', async () => {
            await User.findByIdAndUpdate(userId, { is_online: false });

            // Notify only relevant people
            const offlinePartners = await getActiveChatPartners(userId);
            offlinePartners.forEach(partnerId => {
                io.to(partnerId).emit('user_status_change', { userId: userId, isOnline: false });
            });

            console.log(`❌ Disconnected: ${user.username}`);
        });
    });
};