import cookie from 'cookie';
import { verifyAccessToken } from '../utils/token.js';
import { prisma } from '../prisma.js'; 

/* auth middleware for WebSocket connections, we can't use the same middleware 'middleware/auth.js' used for other HTTP requests, 
 Because Socket.io is NOT HTTP after the initial handshake, as 'res' doesn't exist anymore. */
export const authMiddleware = async (socket, next) => {
  try {
    let token = null;                 // Initialize token variable

    // 1️⃣ Try to get token from cookies (web apps), then set the token variable 
    const rawCookie = socket.handshake.headers.cookie;
    if (rawCookie) { const parsed = cookie.parse(rawCookie); token = parsed.accessToken; }

    // 2️⃣ If no cookie, try from handshake.auth.token (mobile / custom clients), then set the token variable
    if (!token && socket.handshake.auth?.token) { token = socket.handshake.auth.token; }

    // If no token found in any source, reject the connection
    if (!token) { return next(new Error('No access token provided, please login')); }


    // Verify token (throws if invalid/expired)
    const payload = verifyAccessToken(token);

    // Fetch user from database , if not found or banned, reject the connection
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, name: true, email: true, role: true, image: true, bannedAt: true, } });
    if (!user) { return next(new Error('User not found')); }
    if (user.bannedAt) { return next(new Error('Your account has been suspended')); }

    // Attach user to socket for use in event handlers
    socket.user = user;
    next();
  } catch (err) {
    console.error('Socket auth error:', err.message);     // Log the error for debugging
    next(new Error('Authentication failed'));             // Pass the error to the next middleware
  }
};