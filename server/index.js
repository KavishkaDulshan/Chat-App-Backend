const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const chatRoutes = require('./routes/chatRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const socketHandler = require('./sockets/socketHandler');

// --- CORS Configuration ---
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000'];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    // Exact match against whitelist
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // Allow any localhost/127.0.0.1 origin (Flutter web dev server uses random ports)
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    console.warn(`⚠️ CORS rejected origin: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
};

const app = express();

// Trust the first proxy (Docker/Nginx/Azure reverse proxy)
// Required for express-rate-limit to correctly read client IPs
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions
});

// --- Rate Limiters ---
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,                  // 100 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // 10 auth attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' },
});

// 1. Connect to Database
connectDB();

// 2. Global Middleware
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(mongoSanitize());
app.use(xss());
app.use(cors(corsOptions));
app.use(globalLimiter);

// 3. API Routes (auth limiter applied to sensitive auth endpoints)
app.use('/register', authLimiter);
app.use('/login', authLimiter);
app.use('/verify-otp', authLimiter);

app.use('/', authRoutes);      // /register, /login, /search
app.use('/chat', chatRoutes);  // <--- CHANGED: Added '/chat' prefix to match Frontend
app.use('/', uploadRoutes);    // /upload

// 4. Initialize Socket Logic
socketHandler(io);

// 5. Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});