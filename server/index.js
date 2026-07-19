// Polyfill for global crypto required by @azure/storage-blob in Node 18
const { webcrypto } = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

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
const chatRoutes = require('./routes/chatRoutes');
const contactRoutes = require('./routes/contactRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const socketHandler = require('./sockets/socketHandler');
const correlationId = require('./middleware/correlationId');
const logger = require('./utils/logger');

// --- CORS Configuration ---
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000'];

// Automatically add http equivalent of allowed origins to help with HTTP-only setups
const allAllowedOrigins = [...allowedOrigins];
allowedOrigins.forEach(origin => {
  if (origin.startsWith('https://')) {
    allAllowedOrigins.push(origin.replace('https://', 'http://'));
  }
});

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    // Exact match against whitelist
    if (allAllowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // Allow any blinkchat domain (both http and https)
    if (/^https?:\/\/blinkchat\.uaenorth\.cloudapp\.azure\.com$/.test(origin)) {
      return callback(null, true);
    }
    // Allow any localhost/127.0.0.1 origin (Flutter web dev server uses random ports)
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    logger.warn('CORS rejected origin', { origin });
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
};

const app = express();

// Trust the first proxy (Docker/Nginx/Azure reverse proxy)
// Required for express-rate-limit to correctly read client IPs
app.set('trust proxy', true);

// --- Phase 0: Correlation ID + Request Logging ---
app.use(correlationId);

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode}`, {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: duration,
      ip: req.ip,
    });
  });
  next();
});
// -------------------------------------------------

const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions
});

// --- Rate Limiters ---
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,                  // 500 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// 1. Connect to Database
connectDB();

// 2. Global Middleware
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '10kb' }));
app.use(mongoSanitize());
app.use(xss());
app.use(cors(corsOptions));
app.use(globalLimiter);

// 3. API Routes (auth routes are now handled by auth-service via gateway)
app.use('/chat', chatRoutes);
app.use('/contacts', contactRoutes);
app.use('/', uploadRoutes);

// 4. Initialize Socket Logic
socketHandler(io);

// 5. Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Server started`, { port: PORT, nodeEnv: process.env.NODE_ENV });
});