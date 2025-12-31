const User = require('../models/User');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const { encrypt, decrypt } = require('../utils/crypto');
const socketAuth = require('../middleware/socketAuth'); // <--- Import Middleware

module.exports = (io) => {
    // 1. USE MIDDLEWARE (The logic is now in the middleware folder)
    io.use(socketAuth);

    // 2. Connection Handler
    io.on('connection', (socket) => {
        const user = socket.data.user;
        const userId = user.id;

        console.log(`✅ Secure Connection: ${user.username}`);
        socket.join(userId);
        User.findByIdAndUpdate(userId, { is_online: true }).exec();
        socket.broadcast.emit('user_status_change', { userId: userId, isOnline: true });

        // CHAT MESSAGE
        socket.on('chat_message', async (msgData) => {
            try {
                const { content, roomId, type = 'text' } = msgData;
                const senderId = socket.data.user.id;

                const encryptedContent = encrypt(content);

                const newMessage = new Message({
                    conversation_id: roomId,
                    sender_id: senderId,
                    content: encryptedContent,
                    type: type
                });
                await newMessage.save();

                const conversation = await Conversation.findByIdAndUpdate(roomId, {
                    last_message: type === 'image' ? '📷 Image' : encryptedContent,
                    updatedAt: new Date()
                }, { new: true });

                const outgoingMessage = {
                    content: content,
                    sender_id: newMessage.sender_id,
                    sender_name: socket.data.user.username,
                    timestamp: newMessage.createdAt,
                    roomId: roomId,
                    type: newMessage.type
                };

                const recipientId = conversation.participants.find(id => id.toString() !== senderId.toString());
                if (recipientId) io.to(recipientId.toString()).emit('chat_message', outgoingMessage);
                io.to(senderId.toString()).emit('chat_message', outgoingMessage);

            } catch (err) {
                console.error('Message Error:', err);
            }
        });

        // JOIN PRIVATE CHAT
        socket.on('join_private_chat', async (targetUserId) => {
            try {
                const myUserId = socket.data.user.id;
                let conversation = await Conversation.findOne({
                    participants: { $all: [myUserId, targetUserId] }
                });

                if (!conversation) {
                    conversation = new Conversation({
                        participants: [myUserId, targetUserId],
                        last_message: 'Start of conversation'
                    });
                    await conversation.save();
                }

                const rawMessages = await Message.find({ conversation_id: conversation._id })
                    .sort({ createdAt: -1 })
                    .limit(50);
                const messages = rawMessages.reverse();

                const history = messages.map(m => ({
                    content: decrypt(m.content),
                    sender_id: m.sender_id,
                    sender_name: (m.sender_id.toString() === myUserId.toString()) ? 'Me' : 'Partner',
                    timestamp: m.createdAt,
                    roomId: conversation._id,
                    type: m.type || 'text'
                }));

                socket.join(conversation._id.toString());
                socket.emit('private_chat_ready', { roomId: conversation._id, history: history });

            } catch (err) {
                console.error(err);
            }
        });

        // TYPING
        socket.on('typing', (roomId) => {
            socket.broadcast.to(roomId).emit('display_typing', { username: socket.data.user.username, roomId });
        });

        socket.on('stop_typing', (roomId) => {
            socket.broadcast.to(roomId).emit('hide_typing', { roomId });
        });

        // DISCONNECT
        socket.on('disconnect', async () => {
            await User.findByIdAndUpdate(userId, { is_online: false });
            io.emit('user_status_change', { userId: userId, isOnline: false });
            console.log(`❌ Disconnected: ${user.username}`);
        });
    });
};