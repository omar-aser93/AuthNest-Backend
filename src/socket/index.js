import { authMiddleware } from './middleware.js';
import { handleChatEvents } from './chatEvents.js';
import { endCallIfNoActiveParticipants } from './callHelpers.js';
import { prisma } from '../prisma.js';  

// Track online users: userId -> Set of socket ids
const onlineUsers = new Map();

// Expose io instance so REST controllers can broadcast after file uploads
let _io = null;
export const getIO = () => _io;


// This function initializes the Socket.io server, applies authentication middleware, and sets up event handlers for chat functionality and presence.
export const initSocket = (io) => {
  _io = io;  // store reference

  // 1. Apply socket authentication middleware to all socket connections
  io.use(authMiddleware);

  io.on('connection', async (socket) => {
    try {
      const userId = socket.user.id;    // from middleware

      // --- Presence: mark user online ---
      if (!onlineUsers.has(userId)) { onlineUsers.set(userId, new Set()) }
      onlineUsers.get(userId).add(socket.id);

      // Join user's personal room (for targeted notifications)
      socket.join(`user:${userId}`);

      // Send current online users to this new client
      const currentOnline = Array.from(onlineUsers.keys());
      socket.emit('online_users', { users: currentOnline });

      // Notify all other clients that this user is now online
      socket.broadcast.emit('user_online', { userId });

      // --- Auto-join all conversation rooms this user belongs to ---
      const participations = await prisma.conversationParticipant.findMany({ where: { userId }, select: { conversationId: true } });
      participations.forEach(({ conversationId }) => { socket.join(`conversation:${conversationId}`) });

      // --- Register all chat-related event handlers ---
      handleChatEvents(io, socket, onlineUsers);

      // --- Disconnect handler ---
      socket.on('disconnect', async () => {
        try {
          // Remove this socket from online tracking
          const userSockets = onlineUsers.get(userId);
          if (userSockets) {
            userSockets.delete(socket.id);
            // Only broadcast offline if user has NO remaining open sockets (handles multiple tabs/devices gracefully)
            if (userSockets.size === 0) {
              onlineUsers.delete(userId);                          // Remove user from online tracking
              socket.broadcast.emit('user_offline', { userId });   // Broadcast that user went offline
            }
          }

          // Clean up any active call this user was in (caller OR callee)
          const activeParticipations = await prisma.callParticipant.findMany({
            where: { userId, status: { in: ['ACTIVE', 'RINGING'] }, call: { endedAt: null } },
            include: { call: { select: { id: true, conversationId: true, callerId: true } } },
          });
          for (const p of activeParticipations) {
            await prisma.callParticipant.update({ where: { id: p.id }, data: { status: 'LEFT', leftAt: new Date() } });
            io.to(`conversation:${p.call.conversationId}`).emit('call_participant_left', { callId: p.call.id, userId });
            await endCallIfNoActiveParticipants(io, p.call.id, p.call.conversationId, p.call.callerId);
          }
        } catch (err) {
          console.error('disconnect handler error:', err);
        }
      });
    } catch (err) {
      console.error('Socket connection error:', err);     // Log the error
      socket.disconnect(true);                            // force disconnect on error
    }
  });
};