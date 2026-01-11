const mongoose = require('mongoose');
const User = require('../models/User');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const { encrypt, decrypt } = require('../utils/crypto');
const socketAuth = require('../middleware/socketAuth');
const admin = require('../config/firebase'); // <--- NEW: Firebase Admin Import

// Helper: Find people who have chatted with this user
async function getActiveChatPartners(userId) {
    try {
        const conversations = await Conversation.find({
            participants: userId
        }).select('participants');

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

        console.log(`✅ Secure Connection: ${user.username}`);
        socket.join(userId); // REQUIRED for targeted messages
        User.findByIdAndUpdate(userId, { is_online: true }).exec();

        // Notify partners
        const onlinePartners = await getActiveChatPartners(userId);
        onlinePartners.forEach(partnerId => {
            io.to(partnerId).emit('user_status_change', { userId: userId, isOnline: true });
        });

        // 1. CHAT MESSAGE
        socket.on('chat_message', async (msgData) => {
            try {
                let { content, roomId, type = 'text' } = msgData;
                const senderId = socket.data.user.id;

                if (!mongoose.Types.ObjectId.isValid(roomId)) {
                    const parts = roomId.split('_');
                    if (parts.length === 2) {
                        let conv = await Conversation.findOne({ participants: { $all: parts } });
                        if (!conv) {
                            conv = new Conversation({ participants: parts, last_message: 'Start' });
                            await conv.save();
                        }
                        roomId = conv._id.toString();
                    }
                }

                const encryptedContent = encrypt(content);
                const newMessage = new Message({
                    conversation_id: roomId,
                    sender_id: senderId,
                    content: encryptedContent,
                    type: type,
                    status: 'sent'
                });
                await newMessage.save();

                const conversation = await Conversation.findByIdAndUpdate(roomId, {
                    last_message: type === 'image' ? '📷 Image' : encryptedContent,
                    updatedAt: Date.now()
                }, { new: true });

                const payload = {
                    _id: newMessage._id,
                    content: content,
                    sender_id: senderId,
                    sender_name: user.username,
                    timestamp: newMessage.createdAt,
                    roomId: roomId,
                    type: type,
                    isDeleted: false,
                    status: 'sent'
                };

                // TARGETED EMIT + PUSH NOTIFICATION
                if (conversation && conversation.participants) {
                    conversation.participants.forEach(async (participantId) => {
                        const pidStr = participantId.toString();

                        // 1. Send via Socket (Fast, Real-time)
                        io.to(pidStr).emit('chat_message', payload);

                        // 2. Check for Offline Push Notification
                        if (pidStr !== senderId) {
                            try {
                                const recipient = await User.findById(participantId);

                                // Logic: Only send if user is OFFLINE and has Tokens
                                if (recipient && !recipient.is_online && recipient.fcm_tokens && recipient.fcm_tokens.length > 0) {
                                    await admin.messaging().sendEachForMulticast({
                                        tokens: recipient.fcm_tokens,
                                        notification: {
                                            title: `New Message from ${user.username}`,
                                            body: "Tap to view message", // Privacy friendly body
                                        },
                                        // Data payload helps Flutter open the correct chat
                                        data: {
                                            click_action: "FLUTTER_NOTIFICATION_CLICK",
                                            roomId: roomId,
                                            senderId: senderId,
                                            type: "chat_message"
                                        }
                                    });
                                    console.log(`🔔 FCM Notification sent to ${recipient.username}`);
                                }
                            } catch (fcmError) {
                                console.error("❌ FCM Error:", fcmError);
                            }
                        }
                    });
                }

            } catch (err) { console.error("Message Error:", err); }
        });

        // 2. JOIN PRIVATE CHAT
        socket.on('join_private_chat', async (otherUserId) => {
            try {
                const myUserId = socket.data.user.id;
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

                socket.join(roomId); // Only needed for read receipts now
                socket.emit('private_chat_ready', { roomId: roomId, history: history });

            } catch (err) { console.error("Join Chat Error:", err); }
        });

        // 3. READ RECEIPTS & DELETE
        socket.on('conversation:read', async ({ roomId }) => {
            if (!mongoose.Types.ObjectId.isValid(roomId)) return;
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

        socket.on('disconnect', async () => {
            await User.findByIdAndUpdate(userId, { is_online: false });
            const offlinePartners = await getActiveChatPartners(userId);
            offlinePartners.forEach(partnerId => {
                io.to(partnerId).emit('user_status_change', { userId: userId, isOnline: false });
            });
            console.log(`❌ Disconnected: ${user.username}`);
        });
    });
};