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
      const user = await User.findOne({ username });
      if (user) {
        user.is_online = true;
        await user.save();
        socket.data.user = user;

        // --- FIX 1: Join a "Personal Room" using User ID ---
        // This ensures we can reach this user no matter what screen they are on
        socket.join(user._id.toString());
        // ---------------------------------------------------

        socket.emit('login_success', user);
        socket.broadcast.emit('user_status_change', { userId: user._id, isOnline: true });
        console.log(`✅ User ${username} joined Personal Room: ${user._id}`);
      }
    } catch (err) {
      console.error(err);
    }
  });
  // ---------------------------------------------

  // --- EVENT: Chat Message ---
  // --- FIX 2: Upgraded Message Handler ---
  socket.on('chat_message', async (msgData) => {
    try {
      const { content, roomId } = msgData;
      const senderId = socket.data.user._id;

      // 1. Save to DB (Keep this same)
      const newMessage = new Message({
        conversation_id: roomId,
        sender_id: senderId,
        content: content,
      });
      await newMessage.save();

      // 2. Update Conversation (Keep this same)
      const conversation = await Conversation.findByIdAndUpdate(roomId, {
        last_message: content,
        updatedAt: new Date()
      });

      // 3. FIND RECIPIENT
      // Who else is in this chat?
      const recipientId = conversation.participants.find(
        (id) => id.toString() !== senderId.toString()
      );

      // 4. Construct Payload (ADD roomId so client knows where it belongs)
      const outgoingMessage = {
        content: newMessage.content,
        sender_id: newMessage.sender_id,
        sender_name: socket.data.user.username,
        timestamp: newMessage.createdAt,
        roomId: roomId, // <--- CRITICAL: Client needs this to filter!
      };

      // 5. SEND DIRECTLY TO USERS (The Fix)
      // Send to Recipient's Personal Room
      if (recipientId) {
        io.to(recipientId.toString()).emit('chat_message', outgoingMessage);
      }
      // Send back to Sender (for their UI to update)
      io.to(senderId.toString()).emit('chat_message', outgoingMessage);

    } catch (err) {
      console.error('Message Error:', err);
    }
  });

  // --- FIX 3: Upgraded Typing Handler ---
  socket.on('typing', async (roomId) => {
    try {
      // We need to find the recipient to notify them
      const conversation = await Conversation.findById(roomId);
      if (!conversation) return;

      const recipientId = conversation.participants.find(
        (id) => id.toString() !== socket.data.user._id.toString()
      );

      if (recipientId) {
        // Send to their personal room
        io.to(recipientId.toString()).emit('display_typing', {
          username: socket.data.user.username,
          roomId: roomId // Client needs this to know WHICH chat is typing
        });
      }
    } catch (e) { }
  });

  socket.on('stop_typing', async (roomId) => {
    try {
      const conversation = await Conversation.findById(roomId);
      if (!conversation) return;

      const recipientId = conversation.participants.find(
        (id) => id.toString() !== socket.data.user._id.toString()
      );

      if (recipientId) {
        io.to(recipientId.toString()).emit('hide_typing', { roomId });
      }
    } catch (e) { }
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

// --- 3. SEARCH USER (Exact Match) ---
app.get('/search', async (req, res) => {
  try {
    const { username } = req.query;
    // Find user (case-insensitive)
    const user = await User.findOne({
      username: { $regex: new RegExp(`^${username}$`, 'i') }
    }).select('-password'); // Don't send password!

    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 4. GET MY CONVERSATIONS (Inbox) ---
app.get('/conversations/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Find all conversations where I am a participant
    const conversations = await Conversation.find({
      participants: userId
    }).sort({ updatedAt: -1 }); // Newest first

    // We need to fetch the "Other User's" details for each conversation
    // This is a manual "Join" operation
    const populatedConversations = await Promise.all(conversations.map(async (conv) => {
      // Find the participant who is NOT me
      const otherUserId = conv.participants.find(id => id.toString() !== userId);
      const otherUser = await User.findById(otherUserId).select('username email is_online');

      return {
        id: conv._id,
        otherUser: otherUser, // The friend's details
        lastMessage: conv.last_message,
        updatedAt: conv.updatedAt
      };
    }));

    res.json(populatedConversations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});