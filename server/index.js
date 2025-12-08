const express = require('express');
const http = require('http'); // New import
const { Server } = require("socket.io"); // New import
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app); // Wrap express in HTTP server
const io = new Server(server); // Attach Socket.io to the server

const PORT = process.env.PORT || 3000;

// 1. Database Connection
const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/chat-app';
mongoose.connect(mongoUri)
  .then(() => console.log('✅ MongoDB Connected!'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// 2. Socket.io Logic (The Chat Engine)
io.on('connection', (socket) => {
  console.log('⚡ A user connected:', socket.id);

  // Listen for a 'chat_message' event from the client (Flutter)
  socket.on('chat_message', (msg) => {
    console.log('📩 Message received:', msg);

    // Broadcast the message to everyone connected (including the sender)
    io.emit('chat_message', msg);
  });

  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.id);
  });
});

// 3. Basic Route
app.get('/', (req, res) => {
  res.send('Chat Server is Running with Socket.io!');
});

// 4. Start Server (Note: we listen on 'server', not 'app')
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});