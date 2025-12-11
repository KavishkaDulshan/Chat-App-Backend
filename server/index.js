const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');
const cors = require('cors');           // NEW
const bcrypt = require('bcryptjs');     // NEW
const jwt = require('jsonwebtoken');    // NEW

// Import Models
const User = require('./models/User');
const Message = require('./models/Message');
const Conversation = require('./models/Conversation');

// -----------------------------------
// 1. CONFIGURATION & SETUP
// -----------------------------------
const app = express();
app.use(express.json()); // NEW: Allows server to read JSON from Flutter
app.use(cors());         // NEW: Fixes connection permissions

const server = http.createServer(app);
const io = new Server(server);


const PORT = process.env.PORT || 3000;
const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/chat-app';

// -----------------------------------
// 2. DATABASE CONNECTION
// -----------------------------------
mongoose.connect(mongoUri)
  .then(() => console.log('✅ MongoDB Connected!'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// -----------------------------------
// 3. HELPER FUNCTIONS
// -----------------------------------

// Helper: Broadcast status updates (Online/Offline) to all clients
const broadcastUserStatus = (userId, isOnline) => {
  io.emit('user_status_change', { userId, isOnline });
};

// Helper: Get or Create a "Global" Chat Room (Legacy/Fallback)
async function getGlobalRoom() {
  let room = await Conversation.findOne({ is_global: true }); // Assuming you might flag global rooms
  // If no specific flag, fallback to finding ANY room or creating a default
  if (!room) {
    room = await Conversation.findOne();
  }

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

// -----------------------------------

// SECRET KEY (In production, put this in a .env file!)
const JWT_SECRET = 'my_super_secret_key_123';

// --- 1. REGISTER ROUTE ---
app.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: "User already exists" });

    // Hash the password (Encryption)
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Save User
    const newUser = new User({
      username,
      email,
      password: hashedPassword
    });
    await newUser.save();

    res.status(201).json({ message: "User created successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 2. LOGIN ROUTE ---
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find User
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "User not found" });

    // Check Password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

    // Generate Token (The "ID Card")
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, {
      expiresIn: '1h' // Token expires in 1 hour
    });

    // Send Token & User Info back to Flutter
    res.json({
      token,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. SOCKET LOGIC
// -----------------------------------
io.on('connection', (socket) => {
  console.log('⚡ Connection attempt:', socket.id);

  socket.on('login', async (username) => {
    try {
      // 1. Find the user (We trust the username because they already authenticated via API)
      const user = await User.findOne({ username });

      if (user) {
        // 2. Mark as Online
        user.is_online = true;
        await user.save();

        // 3. Attach user data to the socket session
        socket.data.user = user;

        // 4. Send Success Signal (CRITICAL: This stops the loading spinner!)
        socket.emit('login_success', user);
        console.log(`✅ User Socket Authenticated: ${username}`);

        // 5. Tell everyone else they are online
        socket.broadcast.emit('user_status_change', {
          userId: user._id,
          isOnline: true
        });
      }
    } catch (err) {
      console.error('Socket Login Error:', err);
    }
  });
  // ---------------------------------------------

  // --- EVENT: Chat Message ---
  socket.on('chat_message', async (msgData) => {
    try {
      if (!socket.data.user) return;

      const { content, roomId } = msgData;
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
      io.to(roomId).emit('chat_message', {
        content: newMessage.content,
        sender_id: newMessage.sender_id,
        sender_name: socket.data.user.username,
        timestamp: newMessage.createdAt
      });

    } catch (err) {
      console.error('Message Error:', err);
    }
  });

  // --- EVENT: Typing Indicators ---
  socket.on('typing', (roomId) => {
    if (!socket.data.user) return;
    console.log(`✍️ ${socket.data.user.username} typing in ${roomId}`);
    socket.to(roomId).emit('display_typing', {
      username: socket.data.user.username
    });
  });

  socket.on('stop_typing', (roomId) => {
    if (!socket.data.user) return;
    console.log(`🛑 ${socket.data.user.username} stopped typing`);
    socket.to(roomId).emit('hide_typing');
  });

  // --- EVENT: Room Management ---
  socket.on('join_room', (roomId) => {
    if (!socket.data.user) return;
    socket.join(roomId);
    console.log(`🔧 ${socket.data.user.username} forcefully joined room: ${roomId}`);
  });

  socket.on('join_private_chat', async (targetUserId) => {
    try {
      const myUserId = socket.data.user._id;

      // 1. Get/Create Room
      const room = await getPrivateConversation(myUserId, targetUserId);
      const roomId = room._id.toString();

      // 2. Join Socket Room
      socket.join(roomId);
      console.log(`🔌 Socket ${socket.id} joined room ${roomId}`);

      // 3. Fetch History
      const history = await Message.find({ conversation_id: roomId })
        .sort({ createdAt: 1 })
        .limit(50)
        .populate('sender_id', 'username');

      // 4. Send Ready Signal
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

  // --- EVENT: Get Users (Contact List) ---
  socket.on('get_users', async () => {
    try {
      // Return all users except self
      const users = await User.find({ _id: { $ne: socket.data.user._id } })
        .select('-password');
      socket.emit('users_list', users);
    } catch (err) {
      console.error('Get Users Error:', err);
    }
  });

  // --- EVENT: Disconnect ---
  socket.on('disconnect', async () => {
    if (socket.data.user) {
      console.log(`❌ User Disconnected: ${socket.data.user.username}`);

      // Update DB
      await User.findByIdAndUpdate(socket.data.user._id, { is_online: false });

      // Notify others using the helper function
      broadcastUserStatus(socket.data.user._id, false);
    }
  });
});

// -----------------------------------
// 5. START SERVER
// -----------------------------------
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});