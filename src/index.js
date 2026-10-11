import express from 'express';
/** Socket.io ****/
import { createServer } from 'http';
import { Server } from 'socket.io';
import { initSocket } from './socket/index.js';
/*****************/
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/v1/authRoutes.js';
import userRoutes from './routes/v1/userRoutes.js';
//import v2UserRoutes from './routes/v2/userRoutes.js';   // v2 routes (future updates, without breaking old apps that still use v1 routes)
import postRoutes from './routes/v1/postRoutes.js';
import savedPostRoutes from './routes/v1/savedPostRoutes.js';
import socialRoutes from './routes/v1/socialRoutes.js';
import notificationsRoutes from './routes/v1/notificationsRoutes.js';
import commentsRoutes from './routes/v1/commentsRoutes.js';
import reactionsRoutes from './routes/v1/reactionsRoutes.js';
import sharesRoutes from './routes/v1/sharesRoutes.js';
import editHistoryRoutes from './routes/v1/editHistoryRoutes.js';
import reportRoutes from './routes/v1/reportRoutes.js';
import chatRoutes from './routes/v1/chatRoutes.js';
import adminRoutes from './routes/v1/adminRoutes.js';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';

dotenv.config();


const app = express();                  // create express app
app.set('trust proxy', 1);              // trust first proxy (Used for rate limiting fix - Behind Render/Railway/Nginx, every request appears to come from the proxy IP. Your rate limiters become globally shared)
const httpServer = createServer(app);   // wrap express in http (used for socket.io)

// Health check, Because we'll use Render to deploy our backend, this endpoint is useful for Render's health checks & to fix (free tier sleeps after 15 min idle) by pinging to this endpoint (using uptimerobot).
// go to "https://dashboard.uptimerobot.com/sign-up" & enter the full health endpoint with render domain "https://authnest-backend-v0ty.onrender.com/health" & sign-up/log-in with google account, a check monitor will be created.
// to add health checks to render itself, go to your render service -> "Settings" → scroll to Health Checks section → Edit → enter /health → Save Changes
app.get("/health", (req, res) => res.json({ ok: true }));


// Allow frontend & admin origins
const allowedOrigins = [process.env.FRONTEND_ORIGIN || 'http://localhost:3000', process.env.ADMIN_ORIGIN || 'http://localhost:5174'].filter(Boolean);

// Socket.io setup
const io = new Server(httpServer, { cors: { origin: allowedOrigins, credentials: true }});
initSocket(io);     // pass io to socket handler, File we created "src/socket/index.js"

// Middlewares (security, logging, parsing, rate limiting, etc..)
app.use(helmet());
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));  
app.use(cookieParser());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 250, // allow 250 requests every 15 minutes
  message: { message: 'Too many requests, slow down' }
});
app.use(limiter);


// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/posts', postRoutes);
app.use("/api/v1/saved-posts", savedPostRoutes);
app.use("/api/v1/social", socialRoutes);
app.use("/api/v1/notifications", notificationsRoutes);
app.use("/api/v1/comments", commentsRoutes);
app.use("/api/v1/reactions", reactionsRoutes);
app.use("/api/v1/shares", sharesRoutes);
app.use("/api/v1/edit-history", editHistoryRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use("/api/v1/chat", chatRoutes);
app.use("/api/v1/admin", adminRoutes);


// Global server error handler used with all controllers (for uncaught exceptions & unhandled rejections)
app.use((err, req, res, next) => {
  console.error(err);
  const isProd = process.env.NODE_ENV === 'production';
  const status = err.status || 500;
  res.status(status).json({ message: status >= 500 && isProd ? 'Server error' : (err.message || 'Server error') });
});

// Start the server (with Socket.io support as well)
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => console.log(`Server listening on ${PORT}`));
