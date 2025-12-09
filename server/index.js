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

  // 2. EVENT: Chat Message (THIS WAS MISSING)
  socket.on('chat_message', async (msgData) => {
    try {
      // Security Check: Ensure user is logged in
      if (!socket.data.user) return;

      console.log('📩 Message Received:', msgData.content);

      // A. Find the Global Room
      const room = await getGlobalRoom();

      // B. Save Message to MongoDB
      const newMessage = new Message({
        conversation_id: room._id,
        sender_id: socket.data.user._id,
        content: msgData.content,
      });
      await newMessage.save();

      // C. Update the Room's "last message" (for previews)
      room.last_message = msgData.content;
      await room.save();

      // D. Broadcast to everyone (Adding the sender's name for the UI)
      // We construct a UI-friendly object to send back
      const outgoingMessage = {
        content: newMessage.content,
        sender_id: newMessage.sender_id,
        sender_name: socket.data.user.username, // Attach name so clients don't show "Unknown"
        timestamp: newMessage.createdAt
      };

      io.emit('chat_message', outgoingMessage);

    } catch (err) {
      console.error('Message Error:', err);
    }
  });

  // 3. EVENT: Disconnect
  socket.on('disconnect', async () => {
    if (socket.data.user) {
      await User.findByIdAndUpdate(socket.data.user._id, { is_online: false });
      console.log(`❌ User Disconnected: ${socket.data.user.username}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});