const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');

// Import All Models
const User = require('./models/User');
const Message = require('./models/Message');
const Conversation = require('./models/Conversation');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/chat-app';

// Helper to broadcast user status updates
const broadcastUserStatus = (userId, isOnline) => {
  io.emit('user_status_change', { userId, isOnline });
};

mongoose.connect(mongoUri)
  .then(() => console.log('✅ MongoDB Connected!'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Helper: Get or Create a "Global" Chat Room
async function getGlobalRoom() {
  // We look for ANY conversation. If none exists, create one.
  // In a real app, you would look for specific participants.
  let room = await Conversation.findOne();
  if (!room) {
    room = new Conversation({ last_message: "Welcome to Global Chat" });
    await room.save();
    console.log("🆕 Created Global Chat Room");
  }
  return room;
}

// Helper: Get or Create a Private Room between two users
async function getPrivateConversation(user1Id, user2Id) {
  // 1. Try to find a conversation with these exact 2 participants
  let conversation = await Conversation.findOne({
    participants: { $all: [user1Id, user2Id] }
  });

  // 2. If not found, create a new one
  if (!conversation) {
    conversation = new Conversation({
      participants: [user1Id, user2Id],
      last_message: 'Start of conversation'
    });
    await conversation.save();
    console.log(`🆕 Created Private Room for ${user1Id} & ${user2Id}`);
  }
  return conversation;
}

io.on('connection', (socket) => {
  console.log('⚡ Connection attempt:', socket.id);

  // 1. EVENT: User Logs In
  socket.on('login', async (username) => {
    try {
      // 1. Find or Create User (Same as before)
      let user = await User.findOne({ username });
      if (!user) {
        user = new User({ username, is_online: true });
        await user.save();
        console.log(`🆕 New User Created: ${username}`);
      } else {
        user.is_online = true;
        await user.save();
        console.log(`👋 User Logged In: ${username}`);
      }

      socket.data.user = user;
      socket.emit('login_success', user);

      // --- NEW CODE STARTS HERE ---

      user.is_online = true;
      await user.save();

      socket.data.user = user;
      socket.emit('login_success', user);

      // NEW: Tell everyone else "User X is Online"
      socket.broadcast.emit('user_status_change', {
        userId: user._id,
        isOnline: true
      });

      // 2. Fetch Chat History
      // We need to find the room ID first to get its messages
      const room = await getGlobalRoom();

      // Find messages for this room, sort by time (oldest first), limit to 50
      const history = await Message.find({ conversation_id: room._id })
        .sort({ createdAt: 1 })
        .limit(50)
        .populate('sender_id', 'username'); // "Join" operation to get username strings

      // 3. Send History to Client
      // We map the data to match the format our Flutter app expects
      const formattedHistory = history.map(msg => ({
        content: msg.content,
        sender_id: msg.sender_id._id,
        sender_name: msg.sender_id.username,
        timestamp: msg.createdAt
      }));

      socket.emit('history_load', formattedHistory);

      // --- NEW CODE ENDS HERE ---

    } catch (err) {
      console.error('Login Error:', err);
    }
  });

  // EVENT: Chat Message (Upgraded for Private Rooms)
  socket.on('chat_message', async (msgData) => {
    try {
      if (!socket.data.user) return;

      const { content, roomId } = msgData; // Client must now send roomId
      console.log(`📩 Message to ${roomId}:`, content);

      // A. Save to MongoDB
      const newMessage = new Message({
        conversation_id: roomId,
        sender_id: socket.data.user._id,
        content: content,
      });
      await newMessage.save();

      // B. Update Last Message Preview
      await Conversation.findByIdAndUpdate(roomId, {
        last_message: content,
        updatedAt: new Date()
      });

      // C. Broadcast ONLY to that room
      const outgoingMessage = {
        content: newMessage.content,
        sender_id: newMessage.sender_id,
        sender_name: socket.data.user.username,
        timestamp: newMessage.createdAt
      };

      // use 'to(roomId)' so only people in this chat see it!
      io.to(roomId).emit('chat_message', outgoingMessage);

    } catch (err) {
      console.error('Message Error:', err);
    }
  });

  // 3. EVENT: Disconnect
  socket.on('disconnect', async () => {
    if (socket.data.user) {
      await User.findByIdAndUpdate(socket.data.user._id, { is_online: false });

      // NEW: Tell everyone "User X is Offline"
      io.emit('user_status_change', {
        userId: socket.data.user._id,
        isOnline: false
      });
    }
  });

  // EVENT: Get list of all users (for the Contacts screen)
  socket.on('get_users', async () => {
    try {
      // Find all users EXCEPT the one requesting (don't chat with yourself)
      const users = await User.find({ _id: { $ne: socket.data.user._id } })
        .select('-password'); // Exclude password if you had one
      socket.emit('users_list', users);
    } catch (err) {
      console.error(err);
    }
  });

  // EVENT: User wants to chat with specific person
  socket.on('join_private_chat', async (targetUserId) => {
    try {
      const myUserId = socket.data.user._id;

      // 1. Get the Room ID from DB
      const room = await getPrivateConversation(myUserId, targetUserId);
      const roomId = room._id.toString();

      // 2. Join the Socket.io Room (This is the magic part!)
      socket.join(roomId);
      console.log(`🔌 Socket ${socket.id} joined room ${roomId}`);

      // 3. Fetch History for this specific room
      const history = await Message.find({ conversation_id: roomId })
        .sort({ createdAt: 1 })
        .limit(50)
        .populate('sender_id', 'username');

      // 4. Send "Ready" signal to client with data
      const formattedHistory = history.map(msg => ({
        content: msg.content,
        sender_id: msg.sender_id._id,
        sender_name: msg.sender_id.username,
        timestamp: msg.createdAt
      }));

      socket.emit('private_chat_ready', {
        roomId: roomId,
        history: formattedHistory
      });

    } catch (err) {
      console.error('Private Chat Error:', err);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});