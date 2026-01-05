const User = require('../models/User');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const { encrypt, decrypt } = require('../utils/crypto');
const socketAuth = require('../middleware/socketAuth');

module.exports = (io) => {
    io.use(socketAuth);

    io.on('connection', (socket) => {
        const user = socket.data.user;
        const userId = user.id;

        console.log(`✅ Secure Connection: ${user.username}`);
        socket.join(userId);
        User.findByIdAndUpdate(userId, { is_online: true }).exec();
        socket.broadcast.emit('user_status_change', { userId: userId, isOnline: true });

        // 1. CHAT MESSAGE
        socket.on('chat_message', async (msgData) => {
            try {
                const { content, roomId, type = 'text' } = msgData;
                const senderId = socket.data.user.id;
                const encryptedContent = encrypt(content);

                const newMessage = new Message({
                    conversation_id: roomId,
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

                io.to(roomId).emit('chat_message', {
                    _id: newMessage._id,
                    content: content,
                    sender_id: senderId,
                    sender_name: user.username,
                    timestamp: newMessage.createdAt,
                    roomId: roomId,
                    type: type,
                    isDeleted: false,
                    status: 'sent'
                });

            } catch (err) { console.error(err); }
        });

        // 2. MARK AS DELIVERED
        socket.on('message:delivered', async ({ messageId, roomId }) => {
            try {
                const msg = await Message.findById(messageId);
                if (msg && msg.status === 'sent') {
                    msg.status = 'delivered';
                    await msg.save();
                    io.to(roomId).emit('message:status_update', {
                        messageId,
                        status: 'delivered',
                        roomId
                    });
                }
            } catch (err) { console.error(err); }
        });

        // 3. MARK AS READ (The Fix is Here)
        socket.on('conversation:read', async ({ roomId }) => {
            try {
                const myUserId = socket.data.user.id;

                // Mark all messages from the PARTNER as read
                await Message.updateMany(
                    { conversation_id: roomId, sender_id: { $ne: myUserId }, status: { $ne: 'read' } },
                    { $set: { status: 'read' } }
                );

                // Notify Everyone 
                // FIX: Send 'readerId' so the sender knows WHO read it
                io.to(roomId).emit('conversation:read_ack', {
                    roomId,
                    readerId: myUserId
                });
            } catch (err) { console.error(err); }
        });

        // 4. LOAD HISTORY
        socket.on('join_private_chat', async (otherUserId) => {
            try {
                const myUserId = socket.data.user.id;
                let conversation = await Conversation.findOne({ participants: { $all: [myUserId, otherUserId] } });

                if (!conversation) {
                    conversation = new Conversation({ participants: [myUserId, otherUserId], last_message: 'Start of conversation' });
                    await conversation.save();
                }

                const rawMessages = await Message.find({ conversation_id: conversation._id }).sort({ createdAt: -1 }).limit(50);
                const messages = rawMessages.reverse();

                const history = messages.map(m => ({
                    _id: m._id,
                    content: m.isDeleted ? "This message was deleted" : decrypt(m.content),
                    sender_id: m.sender_id,
                    sender_name: (m.sender_id.toString() === myUserId.toString()) ? 'Me' : 'Partner',
                    timestamp: m.createdAt,
                    roomId: conversation._id,
                    type: m.type || 'text',
                    isDeleted: m.isDeleted,
                    status: m.status
                }));

                socket.join(conversation._id.toString());
                socket.emit('private_chat_ready', { roomId: conversation._id, history: history });
            } catch (err) { console.error(err); }
        });

        // DELETE HANDLER
        socket.on('message:delete', async ({ messageId, roomId }) => {
            try {
                const msg = await Message.findById(messageId);
                if (!msg || msg.sender_id.toString() !== socket.data.user.id) return;
                msg.isDeleted = true;
                await msg.save();
                io.to(roomId).emit('message:deleted', messageId);
            } catch (err) { console.error(err); }
        });

        socket.on('typing', (roomId) => socket.broadcast.to(roomId).emit('display_typing', { username: socket.data.user.username, roomId }));
        socket.on('stop_typing', (roomId) => socket.broadcast.to(roomId).emit('hide_typing', { roomId }));

        socket.on('disconnect', async () => {
            await User.findByIdAndUpdate(userId, { is_online: false });
            io.emit('user_status_change', { userId: userId, isOnline: false });
            console.log(`❌ Disconnected: ${user.username}`);

        });
    });
};