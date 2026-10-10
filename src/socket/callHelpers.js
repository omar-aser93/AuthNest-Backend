import { prisma } from '../prisma.js';

// (LIVEKIT) Helper function to check if there are any active participants left in the call, if not, end the call
export const endCallIfNoActiveParticipants = async (io, callId, conversationId, callerId) => {
  const otherActive = await prisma.callParticipant.count({
    where: { callId, userId: { not: callerId }, status: { in: ['RINGING', 'ACTIVE'] } },
  });
  if (otherActive === 0) {
    await prisma.$transaction([
      prisma.callParticipant.updateMany({
        where: { callId, status: { in: ['ACTIVE', 'RINGING'] } },
        data: { status: 'ENDED', leftAt: new Date() },
      }),
      prisma.call.update({ where: { id: callId }, data: { endedAt: new Date() } }),
    ]);
    io.to(`conversation:${conversationId}`).emit('call_ended_all', { callId });
  }
};


// Helper function to Create a system message in a conversation like "messenger & whatsapp" (call ended, call missed, etc.)
export const createCallSystemMessage = async (io, conversationId, senderId, content) => {
  const message = await prisma.message.create({
    data: { content, conversationId, senderId },
    include: {
      sender: { select: { id: true, name: true, image: true } },
      attachments: true,
      reactions: { include: { user: { select: { id: true, name: true, image: true } } } },
      reads: { include: { user: { select: { id: true, name: true, image: true } } } },
      tags: { include: { tagged: { select: { id: true, name: true, image: true } } } },
    },
  });
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
  io.to(`conversation:${conversationId}`).emit('new_message', message);
};