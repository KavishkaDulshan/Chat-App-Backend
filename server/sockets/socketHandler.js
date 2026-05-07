const mongoose = require('mongoose');
const User = require('../models/User');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const ContactRequest = require('../models/ContactRequest');
const { getContactStatusHelper } = require('../controllers/contactController');
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

                const sender = await User.findById(senderId).select('username profile_pic');

                if (!mongoose.Types.ObjectId.isValid(roomId)) {
                    const parts = roomId.split('_');
                    if (parts.length === 2) {
                        // Guard: check contact status before allowing new conversation creation
                        const otherUserId = parts.find(p => p !== senderId);
                        if (otherUserId) {
                            const status = await getContactStatusHelper(senderId, otherUserId);
                            if (status !== 'contacts') {
                                socket.emit('error', { message: 'You must be contacts before messaging.' });
                                return;
                            }
                        }

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
                    // Find the receiver (the other participant) for the sender's payload
                    const receiverId = conversation.participants.find(p => p.toString() !== senderId);
                    if (receiverId) {
                        const receiver = await User.findById(receiverId).select('username profile_pic');
                        if (receiver) {
                            payload.receiver_id = receiverId.toString();
                            payload.receiver_name = receiver.username;
                            payload.receiver_avatar = receiver.profile_pic;
                        }
                    }

                    conversation.participants.forEach(async (participantId) => {
                        const pidStr = participantId.toString();

                        io.to(pidStr).emit('chat_message', payload);

                        if (pidStr !== senderId) {
                            try {
                                const recipient = await User.findById(participantId);

                                if (recipient && !recipient.is_online && recipient.fcm_tokens && recipient.fcm_tokens.length > 0) {
                                    const fcmPayload = {
                                        tokens: recipient.fcm_tokens,
                                        data: {
                                            click_action: "FLUTTER_NOTIFICATION_CLICK",
                                            roomId: roomId,
                                            senderId: senderId,
                                            type: "chat_message",
                                            content: storedContent, // pass the ciphertext
                                            msgType: type, // text/image/audio
                                            senderName: sender.username
                                        }
                                    };

                                    // If preview is OFF, use standard OS notification banner.
                                    // If preview is ON, we omit 'notification' so Flutter can intercept the data 
                                    // and decrypt it to build a Local Notification containing the true text.
                                    if (!recipient.settings?.showNotificationPreview) {
                                        fcmPayload.notification = {
                                            title: `New Message from ${sender.username}`,
                                            body: type === 'image' ? "Sent an image" : "Tap to view message",
                                        };
                                    }

                                    await admin.messaging().sendEachForMulticast(fcmPayload);
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
                    // Guard: only allow creating new conversations between contacts
                    const status = await getContactStatusHelper(myUserId, otherUserId);
                    if (status !== 'contacts') {
                        socket.emit('error', { message: 'You must be contacts before messaging.' });
                        return;
                    }
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

                // Batch-fetch all unique senders in ONE query (fixes N+1)
                const senderIds = [...new Set(messages.map(m => m.sender_id.toString()))];
                const senderDocs = await User.find({ _id: { $in: senderIds } }).select('username profile_pic');
                const senderMap = {};
                senderDocs.forEach(s => { senderMap[s._id.toString()] = s; });

                const messagesWithDetails = messages.map((m) => {
                    const senderDetails = senderMap[m.sender_id.toString()];
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
                        sender_avatar: senderDetails?.profile_pic || '',
                        timestamp: m.createdAt,
                        roomId: roomId,
                        type: m.type || 'text',
                        isDeleted: m.isDeleted,
                        status: m.status
                    };
                });

                const hasMore = rawMessages.length === 50;
                socket.join(roomId);
                socket.emit('private_chat_ready', { roomId, history: messagesWithDetails, hasMore });

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

                // Batch-fetch senders in ONE query
                const senderIds = [...new Set(messages.map(m => m.sender_id.toString()))];
                const senderDocs = await User.find({ _id: { $in: senderIds } }).select('username profile_pic');
                const senderMap = {};
                senderDocs.forEach(s => { senderMap[s._id.toString()] = s; });

                const messagesWithDetails = messages.map((m) => {
                    const senderDetails = senderMap[m.sender_id.toString()];
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
                        sender_avatar: senderDetails?.profile_pic || '',
                        timestamp: m.createdAt,
                        roomId: roomId,
                        type: m.type || 'text',
                        isDeleted: m.isDeleted,
                        status: m.status
                    };
                });

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
                    try {
                        const decryptedUrl = decrypt(msg.content);
                        await deleteBlob(decryptedUrl);
                    } catch (decErr) {
                        console.error('Failed to decrypt or delete blob:', decErr);
                    }
                    // Hard-delete the document from MongoDB
                    await Message.deleteOne({ _id: messageId });
                } else {
                    // Text messages: soft-delete (keep record)
                    msg.isDeleted = true;
                    msg.content = 'This message was deleted';
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

        // 4. CONTACT REQUEST — real-time notification
        socket.on('contact:send_request', async ({ toUserId }) => {
            try {
                const fromId = socket.data.user.id;
                if (!toUserId || fromId === toUserId) return;

                // Check for duplicate
                const existing = await ContactRequest.findOne({
                    $or: [
                        { from: fromId, to: toUserId },
                        { from: toUserId, to: fromId }
                    ]
                });

                if (existing && existing.status === 'pending') {
                    // If they sent to us, auto-accept
                    if (existing.from.toString() === toUserId) {
                        existing.status = 'accepted';
                        await existing.save();
                        const fromUser = await User.findById(fromId).select('username profile_pic is_online');
                        io.to(toUserId).emit('contact:request_accepted', {
                            byUserId: fromId,
                            byUsername: fromUser?.username,
                            byAvatar: fromUser?.profile_pic,
                        });
                        socket.emit('contact:request_accepted', {
                            byUserId: toUserId,
                            requestId: existing._id,
                        });
                    }
                    return;
                }

                if (existing && existing.status === 'accepted') return;

                // Remove old declined
                await ContactRequest.deleteOne({ from: fromId, to: toUserId, status: 'declined' });
                await ContactRequest.deleteOne({ from: toUserId, to: fromId, status: 'declined' });

                const newReq = new ContactRequest({ from: fromId, to: toUserId });
                await newReq.save();

                const fromUser = await User.findById(fromId).select('username profile_pic is_online');
                // Notify the receiver in real-time
                io.to(toUserId).emit('contact:request_received', {
                    requestId: newReq._id,
                    fromUserId: fromId,
                    fromUsername: fromUser?.username,
                    fromAvatar: fromUser?.profile_pic,
                    fromIsOnline: fromUser?.is_online,
                });

                socket.emit('contact:request_sent', { requestId: newReq._id, toUserId });
            } catch (err) {
                if (err.code !== 11000) console.error('contact:send_request error:', err);
            }
        });

        socket.on('contact:accept_request', async ({ requestId, fromUserId }) => {
            try {
                const myId = socket.data.user.id;
                const request = await ContactRequest.findById(requestId);
                if (!request || request.to.toString() !== myId || request.status !== 'pending') return;

                request.status = 'accepted';
                await request.save();

                const meUser = await User.findById(myId).select('username profile_pic is_online');
                // Notify original sender
                io.to(fromUserId).emit('contact:request_accepted', {
                    byUserId: myId,
                    byUsername: meUser?.username,
                    byAvatar: meUser?.profile_pic,
                });
                // Confirm to acceptor
                socket.emit('contact:request_accepted', { byUserId: fromUserId, requestId });
            } catch (err) {
                console.error('contact:accept_request error:', err);
            }
        });

        socket.on('contact:decline_request', async ({ requestId }) => {
            try {
                const myId = socket.data.user.id;
                const request = await ContactRequest.findById(requestId);
                if (!request) return;
                
                // Allow either to or from to cancel/decline
                if (request.to.toString() !== myId && request.from.toString() !== myId) return;
                
                request.status = 'declined';
                await request.save();
                
                // Notify the person who cancelled/declined
                socket.emit('contact:request_declined', { requestId, byUserId: myId });
                
                // Notify the other person
                const otherId = request.to.toString() === myId ? request.from.toString() : request.to.toString();
                io.to(otherId).emit('contact:request_declined', { requestId, byUserId: myId });
            } catch (err) {
                console.error('contact:decline_request error:', err);
            }
        });

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
