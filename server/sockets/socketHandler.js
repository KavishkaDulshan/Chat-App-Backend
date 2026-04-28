const mongoose = require('mongoose');
const User = require('../models/User');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const { encrypt, decrypt } = require('../utils/crypto');
const socketAuth = require('../middleware/socketAuth');
const admin = require('../config/firebase');
const { deleteBlob } = require('../config/azureStorage');

const isE2EEnvelope = (text) => typeof text === 'string' && text.startsWith('e2e:v1:');

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
        socket.join(userId);
        User.findByIdAndUpdate(userId, { is_online: true }).exec();

        const onlinePartners = await getActiveChatPartners(userId);
        onlinePartners.forEach(partnerId => {
            io.to(partnerId).emit('user_status_change', { userId: userId, isOnline: true });
        });

        // 1. CHAT MESSAGE
        socket.on('chat_message', async (msgData) => {
            try {
                let { content, roomId, type = 'text' } = msgData;
                const senderId = socket.data.user.id;

                // --- FIX 1: DEFINE SENDER ---
                const sender = await User.findById(senderId).select('username profile_pic');
                // ----------------------------

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

                const shouldKeepCiphertext = type === 'text' && isE2EEnvelope(content);
                const storedContent = shouldKeepCiphertext ? content : encrypt(content);

                const newMessage = new Message({
                    conversation_id: roomId,
                    sender_id: senderId,
                    content: storedContent,
                    type: type,
                    status: 'sent'
                });
                await newMessage.save();

                const conversation = await Conversation.findByIdAndUpdate(roomId, {
                    last_message: type === 'image'
                        ? '📷 Image'
                        : (shouldKeepCiphertext ? 'Encrypted message' : storedContent),
                    updatedAt: Date.now()
                }, { new: true });

                const payload = {
                    _id: newMessage._id,
                    content: content,
                    sender_id: senderId,
                    sender_name: sender.username,     // Use fetched sender
                    sender_avatar: sender.profile_pic, // Use fetched sender
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

                        io.to(pidStr).emit('chat_message', payload);

                        if (pidStr !== senderId) {
                            try {
                                const recipient = await User.findById(participantId);

                                if (recipient && !recipient.is_online && recipient.fcm_tokens && recipient.fcm_tokens.length > 0) {
                                    await admin.messaging().sendEachForMulticast({
                                        tokens: recipient.fcm_tokens,
                                        notification: {
                                            title: `New Message from ${sender.username}`,
                                            body: type === 'image' ? "Sent an image" : "Tap to view message",
                                        },
                                        data: {
                                            click_action: "FLUTTER_NOTIFICATION_CLICK",
                                            roomId: roomId,
                                            senderId: senderId,
                                            type: "chat_message"
                                        }
                                    });
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

                // Fetch sender details for avatar in history
                const messagesWithDetails = await Promise.all(messages.map(async (m) => {
                    const senderDetails = await User.findById(m.sender_id).select('username profile_pic');

                    let resolvedContent = m.content;
                    if (m.isDeleted) {
                        resolvedContent = 'This message was deleted';
                    } else if (m.type === 'text' && isE2EEnvelope(m.content)) {
                        resolvedContent = m.content;
                    } else {
                        resolvedContent = decrypt(m.content);
                    }

                    return {
                        _id: m._id,
                        content: resolvedContent,
                        sender_id: m.sender_id,
                        sender_name: (m.sender_id.toString() === myUserId.toString()) ? 'Me' : (senderDetails?.username || 'Partner'),
                        sender_avatar: senderDetails?.profile_pic || "", // Include Avatar
                        timestamp: m.createdAt,
                        roomId: roomId,
                        type: m.type || 'text',
                        isDeleted: m.isDeleted,
                        status: m.status
                    };
                }));

                const hasMore = rawMessages.length === 50;
                socket.join(roomId);
                socket.emit('private_chat_ready', { roomId: roomId, history: messagesWithDetails, hasMore: hasMore });

            } catch (err) { console.error("Join Chat Error:", err); }
        });

        // 2b. LOAD MORE MESSAGES (cursor-based pagination)
        socket.on('load_more_messages', async ({ roomId, beforeId }) => {
            try {
                if (!mongoose.Types.ObjectId.isValid(roomId) || !mongoose.Types.ObjectId.isValid(beforeId)) return;

                const myUserId = socket.data.user.id;
                const rawMessages = await Message.find({
                    conversation_id: roomId,
                    _id: { $lt: beforeId }
                })
                    .sort({ createdAt: -1 })
                    .limit(50);
                const messages = rawMessages.reverse();

                const messagesWithDetails = await Promise.all(messages.map(async (m) => {
                    const senderDetails = await User.findById(m.sender_id).select('username profile_pic');

                    let resolvedContent = m.content;
                    if (m.isDeleted) {
                        resolvedContent = 'This message was deleted';
                    } else if (m.type === 'text' && isE2EEnvelope(m.content)) {
                        resolvedContent = m.content;
                    } else {
                        resolvedContent = decrypt(m.content);
                    }

                    return {
                        _id: m._id,
                        content: resolvedContent,
                        sender_id: m.sender_id,
                        sender_name: (m.sender_id.toString() === myUserId.toString()) ? 'Me' : (senderDetails?.username || 'Partner'),
                        sender_avatar: senderDetails?.profile_pic || "",
                        timestamp: m.createdAt,
                        roomId: roomId,
                        type: m.type || 'text',
                        isDeleted: m.isDeleted,
                        status: m.status
                    };
                }));

                const hasMore = rawMessages.length === 50;
                socket.emit('more_messages', { roomId, messages: messagesWithDetails, hasMore });
            } catch (err) { console.error("Load More Messages Error:", err); }
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

                // Hard-delete media blobs from Azure to reclaim storage
                if (msg.type === 'image' || msg.type === 'audio') {
                    await deleteBlob(msg.content);
                    // Hard-delete the document from MongoDB
                    await Message.deleteOne({ _id: messageId });
                } else {
                    // Text messages: soft-delete (keep record)
                    msg.isDeleted = true;
                    msg.content = '';
                    await msg.save();
                }

                io.to(roomId).emit('message:deleted', messageId);
            } catch (err) { console.error('message:delete error:', err); }
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
