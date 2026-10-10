import { prisma } from '../prisma.js';
import { getIO } from '../socket/index.js';

// ---------------- CREATE A NOTIFICATION ----------------
export async function createNotification(type, data) {
  const { userId, senderId, postId, commentId, shareId, tagId, requestId, reactionType } = data;  // Destructure data
  
  // 1. Prevent self-notifications
  if (userId === senderId) return null;

  // 2. Check for existing notification, with the same data within the last hour
  const existing = await prisma.notification.findFirst({ where: { type, userId, senderId, postId, commentId, shareId, tagId, requestId, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) }} });
  // If notification already exists, update only the timestamp and reactionType if it changed
  if (existing) {    
    return await prisma.notification.update({ where: { id: existing.id }, data: { createdAt: new Date(), ...(reactionType && { reactionType }) }});
  }

  // 3. If notification doesn't exist, Create new notification
  const notification = await prisma.notification.create({
    data: { type, reactionType, userId, senderId, postId, commentId, shareId, tagId, requestId }
  });

  // 4. socket: Emit to recipient's personal room so their bell badge increments live  
  getIO()?.to(`user:${userId}`).emit('new_notification', { count: 1 });

  return notification;    // Return the created notification
}



// ---------------- BULK NOTIFICATION (Creates multiple notifications at once) ----------------
export async function createBulkNotifications(users, data) {
  const notifications = users.map(userId => ({ ...data, userId }));
  await prisma.notification.createMany({ data: notifications });

  // Emit to each recipient
  for (const userId of users) {
    getIO()?.to(`user:${userId}`).emit('new_notification', { count: 1 });
  }
}