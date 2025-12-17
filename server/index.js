//V10

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Models
const User = require('./models/User');
const Message = require('./models/Message');
const Conversation = require('./models/Conversation');

const app = express();
app.use(express.json());
app.use(cors());

const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/chat-app';
const JWT_SECRET = 'my_super_secret_key_123';

mongoose.connect(mongoUri)
  .then(() => console.log('✅ MongoDB Connected!'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- REST API ROUTES ---

app.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: "User already exists" });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({ username, email, password: hashedPassword });
    await newUser.save();

    res.status(201).json({ message: "User created successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "User not found" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });

    res.json({
      token,
      user: { _id: user._id, username: user.username, email: user.email }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SEARCH USER
app.get('/search', async (req, res) => {
  try {
    const { username } = req.query;
    const user = await User.findOne({
      username: { $regex: new RegExp(`^${username}$`, 'i') }
    }).select('-password');

    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET INBOX
app.get('/conversations/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const conversations = await Conversation.find({ participants: userId }).sort({ updatedAt: -1 });

    const populatedConversations = await Promise.all(conversations.map(async (conv) => {
      const otherUserId = conv.participants.find(id => id.toString() !== userId);
      const otherUser = await User.findById(otherUserId).select('username email is_online');
      return {
        id: conv._id,
        otherUser: otherUser,
        lastMessage: conv.last_message,
        updatedAt: conv.updatedAt
      };
    }));

    res.json(populatedConversations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SOCKET LOGIC ---

io.on('connection', (socket) => {
  console.log('⚡ Connection attempt:', socket.id);

  // 1. LOGIN (Join Personal Room)
  socket.on('login', async (username) => {
    try {
      const user = await User.findOne({ username });
      if (user) {
        user.is_online = true;
        await user.save();
        socket.data.user = user;

        // CRITICAL FIX: Join the User ID room for direct delivery
        socket.join(user._id.toString());

        socket.emit('login_success', user);
        socket.broadcast.emit('user_status_change', { userId: user._id, isOnline: true });
        console.log(`✅ User ${username} joined Personal Room: ${user._id}`);
      }
    } catch (err) {
      console.error(err);
    }
  });

  // 2. CHAT MESSAGE (Deliver to Specific Recipient)
  socket.on('chat_message', async (msgData) => {
    try {
      const { content, roomId } = msgData;
      const senderId = socket.data.user._id;

      // Save to DB
      const newMessage = new Message({
        conversation_id: roomId,
        sender_id: senderId,
        content: content,
      });
      await newMessage.save();

      // Update Conversation
      const conversation = await Conversation.findByIdAndUpdate(roomId, {
        last_message: content,
        updatedAt: new Date()
      });

      // Find Recipient
      const recipientId = conversation.participants.find(
        (id) => id.toString() !== senderId.toString()
      );

      const outgoingMessage = {
        content: newMessage.content,
        sender_id: newMessage.sender_id,
        sender_name: socket.data.user.username,
        timestamp: newMessage.createdAt,
        roomId: roomId, // Client needs this to filter
      };

      // SEND TO RECIPIENT (Directly)
      if (recipientId) {
        io.to(recipientId.toString()).emit('chat_message', outgoingMessage);
      }
      // SEND TO SENDER (Directly)
      io.to(senderId.toString()).emit('chat_message', outgoingMessage);

    } catch (err) {
      console.error('Message Error:', err);
    }
  });

  // 3. TYPING (Deliver to Specific Recipient)
  socket.on('typing', async (roomId) => {
    try {
      const conversation = await Conversation.findById(roomId);
      if (!conversation) return;
      const recipientId = conversation.participants.find(
        (id) => id.toString() !== socket.data.user._id.toString()
      );
      if (recipientId) {
        io.to(recipientId.toString()).emit('display_typing', {
          username: socket.data.user.username,
          roomId: roomId
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

  // 4. JOIN PRIVATE CHAT (Updated History Logic)
  socket.on('join_private_chat', async (targetUserId) => {
    try {
      const myUserId = socket.data.user._id;

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

      // --- FIX STARTS HERE ---

      // 1. Get the NEWEST 50 messages (Sort Descending: -1)
      const rawMessages = await Message.find({ conversation_id: conversation._id })
        .sort({ createdAt: -1 })
        .limit(50);

      // 2. Reverse them so they appear chronologically (Old -> New) in the chat
      const messages = rawMessages.reverse();

      // --- FIX ENDS HERE ---

      const history = messages.map(m => ({
        content: m.content,
        sender_id: m.sender_id,
        sender_name: (m.sender_id.toString() === myUserId.toString()) ? 'Me' : 'Partner',
        timestamp: m.createdAt,
        roomId: conversation._id
      }));

      // Join the room (still useful for context)
      socket.join(conversation._id.toString());

      socket.emit('private_chat_ready', {
        roomId: conversation._id,
        history: history
      });

    } catch (err) {
      console.error(err);
    }
  });

  socket.on('disconnect', async () => {
    if (socket.data.user) {
      await User.findByIdAndUpdate(socket.data.user._id, { is_online: false });
      io.emit('user_status_change', { userId: socket.data.user._id, isOnline: false });
    }
  });

  // Keep get_users for legacy support if needed
  socket.on('get_users', async () => {
    const users = await User.find({ _id: { $ne: socket.data.user._id } }).select('-password');
    socket.emit('users_list', users);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});