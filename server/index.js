// V16 - Encryption Fixed

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

// Security Packages
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');

// Import Crypto Utils
const { encrypt, decrypt } = require('./utils/crypto');

// Models
const User = require('./models/User');
const Message = require('./models/Message');
const Conversation = require('./models/Conversation');

const app = express();

// --- SECURITY MIDDLEWARE ---
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(mongoSanitize());
app.use(xss());
app.use(cors());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again in 15 minutes'
});
app.use('/login', limiter);
app.use('/register', limiter);

const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const mongoUri = process.env.MONGO_URI || 'mongodb://mongo:27017/chat-app';
const JWT_SECRET = process.env.JWT_SECRET;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

mongoose.connect(mongoUri)
  .then(() => console.log('✅ MongoDB Connected!'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- ROUTES ---

app.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: "All fields are required" });

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
    if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: "Invalid data format" });

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "User not found" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });

    res.json({ token, user: { _id: user._id, username: user.username, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/search', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username || typeof username !== 'string') return res.json([]);

    const user = await User.findOne({
      username: { $regex: new RegExp(`^${username}$`, 'i') }
    }).select('-password');

    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/conversations/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const conversations = await Conversation.find({ participants: userId }).sort({ updatedAt: -1 });

    const populatedConversations = await Promise.all(conversations.map(async (conv) => {
      const otherUserId = conv.participants.find(id => id.toString() !== userId);
      const otherUser = await User.findById(otherUserId).select('username email is_online');

      // FIX 1: Decrypt the preview message for the list
      let preview = conv.last_message;
      if (preview && !preview.includes('Start of conversation') && !preview.includes('📷 Image')) {
        preview = decrypt(preview);
      }

      return {
        id: conv._id,
        otherUser: otherUser,
        lastMessage: preview, // <--- Send DECRYPTED text to client
        updatedAt: conv.updatedAt
      };
    }));

    res.json(populatedConversations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: "chat_app_uploads" },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(req.file.buffer);
    });

    // We send the PLAIN URL back to the frontend so they can send it as a message
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error("Upload Error:", err);
    res.status(500).json({ error: "Image upload failed" });
  }
});

// --- SOCKET MIDDLEWARE ---
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication error: No Token Provided"));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.data.user = decoded;
    next();
  } catch (err) {
    return next(new Error("Authentication error: Invalid Token"));
  }
});

// --- SOCKET LOGIC ---
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

      // Encrypt for Database
      const encryptedContent = encrypt(content);

      // Save Encrypted
      const newMessage = new Message({
        conversation_id: roomId,
        sender_id: senderId,
        content: encryptedContent,
        type: type
      });
      await newMessage.save();

      // Update Conversation (Encrypted)
      const conversation = await Conversation.findByIdAndUpdate(roomId, {
        last_message: type === 'image' ? '📷 Image' : encryptedContent,
        updatedAt: new Date()
      }, { new: true });

      // FIX 2: Send PLAIN TEXT to the active clients (Real-time)
      const outgoingMessage = {
        content: content, // <--- SEND ORIGINAL 'content', NOT 'newMessage.content'
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

  // 2. JOIN PRIVATE CHAT (HISTORY)
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

      // FIX 3: Decrypt History before sending to client
      const history = messages.map(m => ({
        content: decrypt(m.content), // <--- UNLOCK THE MESSAGE HERE
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

  socket.on('typing', (roomId) => {
    // ... typing logic (same as before) ...
    socket.broadcast.to(roomId).emit('display_typing', { username: socket.data.user.username, roomId });
  });

  socket.on('stop_typing', (roomId) => {
    socket.broadcast.to(roomId).emit('hide_typing', { roomId });
  });

  socket.on('disconnect', async () => {
    await User.findByIdAndUpdate(userId, { is_online: false });
    io.emit('user_status_change', { userId: userId, isOnline: false });
    console.log(`❌ Secure Connection Disconnected: ${user.username}`);

  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});