const User = require('../models/User');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const { encrypt, decrypt } = require('../utils/crypto');
const socketAuth = require('../middleware/socketAuth');

module.exports = (io) => {
    // 1. USE MIDDLEWARE
    io.use(socketAuth);

    // 2. Connection Handler
    io.on('connection', (socket) => {
        const user = socket.data.user; // Accessed via socket.data (Correct)
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
                    type: type,
                    isDeleted: false // Default
                });
                await newMessage.save();

                const conversation = await Conversation.findByIdAndUpdate(roomId, {
                    last_message: type === 'image' ? '📷 Image' : encryptedContent,
                    updatedAt: Date.now()
                });

                // Send back decrypted data to everyone in the room
                io.to(roomId).emit('chat_message', {
                    _id: newMessage._id, // Important for deletion
                    content: content,
                    sender_id: senderId,
                    sender_name: user.username,
                    timestamp: newMessage.createdAt,
                    roomId: roomId,
                    type: type,
                    isDeleted: false
                });

            } catch (err) {
                console.error(err);
            }
        });

        // JOIN PRIVATE CHAT (Load History)
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

                // Load last 50 messages
                const rawMessages = await Message.find({ conversation_id: conversation._id })
                    .sort({ createdAt: -1 })
                    .limit(50);
                const messages = rawMessages.reverse();

                // Decrypt history before sending
                const history = messages.map(m => ({
                    _id: m._id, // Include ID for deletion
                    content: m.isDeleted ? "This message was deleted" : decrypt(m.content),
                    sender_id: m.sender_id,
                    sender_name: (m.sender_id.toString() === myUserId.toString()) ? 'Me' : 'Partner',
                    timestamp: m.createdAt,
                    roomId: conversation._id,
                    type: m.type || 'text',
                    isDeleted: m.isDeleted || false // Send delete status
                }));

                socket.join(conversation._id.toString());
                socket.emit('private_chat_ready', { roomId: conversation._id, history: history });

            } catch (err) {
                console.error(err);
            }
        });

        // === NEW: DELETE MESSAGE HANDLER ===
        socket.on('message:delete', async ({ messageId, roomId }) => {
            try {
                const msg = await Message.findById(messageId);
                if (!msg) return;

                // Security: Only sender can delete
                if (msg.sender_id.toString() !== socket.data.user.id) return;

                // Soft Delete
                msg.isDeleted = true;
                await msg.save();

                // Broadcast delete event to everyone in the room
                io.to(roomId).emit('message:deleted', messageId);

            } catch (err) {
                console.error("Delete Error:", err);
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