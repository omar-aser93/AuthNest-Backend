import { prisma } from '../prisma.js';
import { endCallIfNoActiveParticipants as endCallIfNoActiveParticipantsShared, createCallSystemMessage as makeSystemMessage } from './callHelpers.js'

// Shared message include shape — reused across send/edit to keep emitted shape consistent
const messageInclude = {
  sender: { select: { id: true, name: true, image: true } },
  attachments: true,
  reactions: { include: { user: { select: { id: true, name: true, image: true } } } },
  reads: { include: { user: { select: { id: true, name: true, image: true } } } },
  tags: { include: { tagged: { select: { id: true, name: true, image: true } } } }
};


// handleChatEvents module: defines all chat-related Socket.io event handlers, such as sending messages, typing indicators, etc.
export const handleChatEvents = (io, socket, onlineUsers) => {
  const userId = socket.user.id;         // get userId from socket middleware

  // Local wrappers that pre-bind io + userId so the rest of the file stays unchanged
  const endCallIfNoActiveParticipants = (callId, conversationId, callerId) =>  endCallIfNoActiveParticipantsShared(io, callId, conversationId, callerId);
  const createCallSystemMessage = (conversationId, content) => makeSystemMessage(io, conversationId, userId, content);

  ///  ────────────────── CHAT EVENTS ────────────────────────────────────────────
  // ─── Send Message (text-only — attachments go through REST) ──────────────────
  socket.on('send_message', async ({ conversationId, content, taggedUserIds }, ack) => {
    try {
      if (!content?.trim()) return ack?.({ error: 'Message content is required' });

      // Verify user is a participant of this conversation
      const participant = await prisma.conversationParticipant.findUnique({ where: { userId_conversationId: { userId, conversationId } } });
      if (!participant) return ack?.({ error: 'Not a participant' });

      // Save to DB
      const message = await prisma.message.create({
        data: { content: content.trim(), conversationId, senderId: userId, tags: taggedUserIds?.length ? { create: taggedUserIds.map(taggedId => ({ taggedId, taggedById: userId })) } : undefined },
        include: messageInclude
      });
      
      // Update conversation's last activity timestamp
      await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });

      // Broadcast to everyone in the room (including sender)
      io.to(`conversation:${conversationId}`).emit('new_message', message);

      ack?.({ success: true, message });                  // Send success response & the message
    } catch (err) {
      console.error('send_message error:', err);          // Log the error
      ack?.({ error: 'Failed to send message' });         // Send error response
    }
  });


  // ─── Typing Indicators (no DB — broadcast only) ──────────────────────────────
  socket.on('typing_start', ({ conversationId }) => {
    if (!socket.rooms.has(`conversation:${conversationId}`)) return;  // room doesn't exist -> ignore
    // socket.to() excludes the sender — others in the room see this
    socket.to(`conversation:${conversationId}`).emit('user_typing', { userId, conversationId });
  });

  socket.on('typing_stop', ({ conversationId }) => {
    if (!socket.rooms.has(`conversation:${conversationId}`)) return;   // room doesn't exist -> ignore
    socket.to(`conversation:${conversationId}`).emit('user_stopped_typing', { userId, conversationId });
  });


  // ─── Mark Messages as Read ───────────────────────────────────────────────────
  socket.on('mark_read', async ({ conversationId }) => {
    if (!socket.rooms.has(`conversation:${conversationId}`)) return;   // room doesn't exist -> ignore
    try {
      // Find all messages in this conversation not yet read by this user
      const unreadMessages = await prisma.message.findMany({ where: { conversationId, senderId: { not: userId }, reads: { none: { userId } } }, select: { id: true } });

      // Mark messages as read by creating entries in MessageRead join table - Commented version works with postgres only
      if (unreadMessages.length > 0) {
        // await prisma.messageRead.createMany({
        //   data: unreadMessages.map(msg => ({ userId, messageId: msg.id, readAt: new Date() })),
        //   skipDuplicates: true, // safe guard against race conditions
        // });
        await Promise.all(
          unreadMessages.map(msg =>
            prisma.messageRead.upsert({
              where: { userId_messageId: { userId, messageId: msg.id } },
              update: {},           // already read — no update needed
              create: { userId, messageId: msg.id, readAt: new Date() },
            })
          )
        );
        // Notify other participants that this user has read the conversation
        io.to(`conversation:${conversationId}`).emit('messages_read', { userId, conversationId, readAt: new Date() });
      }      
    } catch (err) {
      console.error('mark_read error:', err);            // Log the error
    }
  });


  // ─── Edit Message ─────────────────────────────────────────────────────────────
  socket.on('edit_message', async ({ messageId, content, taggedUserIds }, ack) => {
    try {
      if (!content?.trim()) return ack?.({ error: 'Content cannot be empty' });

      // Verify message exists and this user is the sender, include existing tags
      const existing = await prisma.message.findFirst({ where: { id: messageId, senderId: userId }, include: { tags: true } });
      if (!existing) return ack?.({ error: 'Message not found or not authorized' });

      // Normalize taggedUserIds & ensure it's an array
      let taggedUsersArray = taggedUserIds || [];
      if (typeof taggedUserIds === 'string') { taggedUsersArray = [taggedUserIds]; }
      // remove self from taggedUserIds (can't tag yourself)
      const uniqueTaggedUsers = [...new Set(taggedUsersArray)].filter(id => id !== userId);
      // Get existing tagged user IDs , then get tagged user IDs to add and remove
      const existingTaggedIds = existing.tags.map(t => t.taggedId);
      const toAdd = uniqueTaggedUsers.filter(id => !existingTaggedIds.includes(id));
      const toRemove = existingTaggedIds.filter(id => !uniqueTaggedUsers.includes(id));

      // Transaction for atomicity
      const updated = await prisma.$transaction(async (tx) => {
        // Save edit history BEFORE overwriting the message content
        await tx.editHistory.create({ data: { messageId, editorId: userId, oldContent: existing.content || '', newContent: content.trim() } });
        // Update message content
        await tx.message.update({ where: { id: messageId }, data: { content: content.trim() } });

        // Handle tag removals
        if (toRemove.length) { await tx.tag.deleteMany({ where: { messageId, taggedId: { in: toRemove } } }); }
        // Handle new tags
        for (const taggedId of toAdd) {
          const userExists = await tx.user.findUnique({ where: { id: taggedId }, select: { id: true } });
          if (userExists) { await tx.tag.create({ data: { messageId, taggedId, taggedById: userId } });} // Optionally send TAG notifications if needed
        }

        // Fetch the full updated message with all includes
        return tx.message.findUnique({ where: { id: messageId }, include: messageInclude  });
      });

      // Broadcast updated message to everyone in the room
      io.to(`conversation:${existing.conversationId}`).emit('message_edited', updated);

      ack?.({ success: true, message: updated });        // Send success & updated message
    } catch (err) {
      console.error('edit_message error:', err);         // Log the error
      ack?.({ error: 'Failed to edit message' });        // Send error response
    }
  });


  // ─── Delete Message (soft delete) [content nulled, record kept] ──────────────────────────────
  // For full hard delete with Cloudinary cleanup, use REST DELETE /messages/:id
  socket.on('delete_message', async ({ messageId }, ack) => {
    try {
      // Verify message exists and this user is the sender
      const existing = await prisma.message.findFirst({ where: { id: messageId, senderId: userId } });
      if (!existing) return ack?.({ error: 'Message not found or not authorized' });

      // Soft delete: null out content (attachments cleaned up via REST delete endpoint)
      await prisma.message.update({ where: { id: messageId }, data: { content: null } });

      // Broadcast updated message to everyone in the room
      io.to(`conversation:${existing.conversationId}`).emit('message_deleted', { messageId, conversationId: existing.conversationId });

      ack?.({ success: true });                        // Send success response
    } catch (err) {
      console.error('delete_message error:', err);     // Log the error
      ack?.({ error: 'Failed to delete message' });    // Send error response
    }
  });

  
  // ─── Join a New Conversation Room ─────────────────────────────────────────────
  // Called after creating a new DM or group so the socket joins without reconnecting
  socket.on('join_conversation', async ({ conversationId }, ack) => {
    try {
      const participant = await prisma.conversationParticipant.findUnique({ where: { userId_conversationId: { userId, conversationId } } });
      if (!participant) return ack?.({ error: 'Not a participant' });
      socket.join(`conversation:${conversationId}`);
      ack?.({ success: true });
    } catch (err) {
      console.error('join_conversation error:', err);
      ack?.({ error: 'Failed to join conversation' });
    }
  });


  // ─── Leave a Conversation Room ────────────────────────────────────────────────
  // Called after leaving/being removed from a group
  socket.on('leave_conversation', ({ conversationId }) => {
    socket.leave(`conversation:${conversationId}`);
  });


  
  // ─── Call Signaling for LiveKit ──────────────────────────────────────────────
  socket.on('call_user', async ({ conversationId, callType }, ack) => {
    try {
      // Verify caller is a participant
      const participant = await prisma.conversationParticipant.findUnique({ where: { userId_conversationId: { userId, conversationId } } });
      if (!participant) return;

      // Get all participants in this conversation
      const participants = await prisma.conversationParticipant.findMany({ where: { conversationId }, select: { userId: true } });
      const otherUserIds = participants.map(p => p.userId).filter(id => id !== userId);
      if (otherUserIds.length === 0) return;   // if no one else to call, just return 

      // ✅ Prevent multiple active calls in same conversation
      const existingActiveCall = await prisma.call.findFirst({ where: { conversationId, endedAt: null }, });
      if (existingActiveCall) { return socket.emit('call_error', { message: 'A call is already active in this conversation.' }); }

      // Create the call record
      const call = await prisma.call.create({
        data: { conversationId, callerId: userId, callType: callType === 'video' ? 'VIDEO' : 'AUDIO',
          participants: {
            create: [
              // ✅ caller
              { userId, status: 'ACTIVE', joinedAt: new Date() },
              // ✅ invited users
              ...otherUserIds.map(calleeId => ({ userId: calleeId, status: 'RINGING' })),
            ],
          },
        },
        include: { participants: {include: { user: { select: { id: true, name: true, image: true }, }, }, }, }, 
      });

      // Send callId back to caller via ack
      ack?.({ callId: call.id });
      // Send incoming_call to each invited user
      for (const calleeId of otherUserIds) {
        io.to(`user:${calleeId}`).emit('incoming_call', { callId: call.id, conversationId, from: userId, fromName: socket.user.name, callType });
      }
     
      // Auto‑miss timeout: after 30 seconds, update all still‑ringing participants to MISSED
      setTimeout(async () => {
        try {
          const missedParticipants = await prisma.callParticipant.findMany({ where: { callId: call.id, status: 'RINGING' }, select: { userId: true }});
          if (missedParticipants.length) {
            // Update all still-RINGING participants to MISSED
            await prisma.callParticipant.updateMany({ where: { callId: call.id, status: 'RINGING' }, data: { status: 'MISSED' } });
            // Add system message for missed call
            await createCallSystemMessage(conversationId, `📞 Missed ${callType} call`);
            // Notify the caller which users missed the call
            io.to(`user:${userId}`).emit('call_missed', { callId: call.id, conversationId, missedBy: missedParticipants.map(p => p.userId) });
            // Auto‑end if no other participant is RINGING or ACTIVE (only caller left)
            await endCallIfNoActiveParticipants(call.id, conversationId, userId);
          }
        } catch (err) {
          console.error('call timeout error:', err);
        }
      }, 30000);
    } catch (err) {
      console.error('call_user error:', err);
      ack?.({ error: 'Failed to start call' });
    }
  });


  // called when a user answers a call (joins the call)
  socket.on('call_answer', async ({ callId }) => {
    try {
      // Find the participant record for this user
      const participant = await prisma.callParticipant.findFirst({ where: { callId, userId }, include: { call: true } });
      if (!participant) return;
      // Update status and joinedAt
      await prisma.callParticipant.update({ where: { id: participant.id }, data: { status: 'ACTIVE', joinedAt: new Date() } });
      // Notify everyone in the conversation (or just the caller) that this user joined, You can emit to the conversation room or to personal rooms
      io.to(`conversation:${participant.call.conversationId}`).emit('call_participant_joined', {
        callId, userId, userName: socket.user.name,
      });
    } catch (err) {
      console.error('call_answer error:', err);
    }
  });


  // Called when a user rejects a call
  socket.on('call_reject', async ({ callId }) => {
    try {
      // Find the participant record for this user
      const participant = await prisma.callParticipant.findFirst({ where: { callId, userId }, include: { call: true } });
      if (!participant) return;
      // Update status to REJECTED
      await prisma.callParticipant.update({ where: { id: participant.id }, data: { status: 'REJECTED' } });
      // Notify the caller that this user rejected the call
      io.to(`conversation:${participant.call.conversationId}`).emit('call_participant_rejected', { callId, userId } );
      // Auto‑end the call if no one else is RINGING or ACTIVE (except caller)
      await endCallIfNoActiveParticipants( callId, participant.call.conversationId, participant.call.callerId );
    } catch (err) {
      console.error('call_reject error:', err);
    }
  });


  // Called when a user leaves a call
  socket.on('call_leave', async ({ callId }) => {
    try {
      // Find the participant record for this user
      const participant = await prisma.callParticipant.findFirst({ where: { callId, userId }, include: { call: true } });
      if (!participant) return;
      // Update status and leftAt
      await prisma.callParticipant.update({ where: { id: participant.id }, data: { status: 'LEFT', leftAt: new Date() } });
      // Notify everyone in the conversation that this user left
      io.to(`conversation:${participant.call.conversationId}`).emit('call_participant_left', { callId, userId });
      // Check if there are any active participants left
      const activeParticipants = await prisma.callParticipant.count({ where: { callId, status: 'ACTIVE', } });
      // If no active participants left, end the call
      if (activeParticipants === 0) {
        await prisma.call.update({ where: { id: callId }, data: { endedAt: new Date() } });
        // Calculate duration and create system message "Call ended · 5m 30s"
        const durationSeconds = Math.floor((Date.now() - new Date(participant.call.startedAt).getTime()) / 1000);
        const mins = Math.floor(durationSeconds / 60);
        const secs = durationSeconds % 60;
        const durationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        await createCallSystemMessage(participant.call.conversationId, `📞 Call ended · ${durationStr}`);
        // Emit call_ended_all to the conversation room so clients can close the call UI
        io.to(`conversation:${participant.call.conversationId}`).emit( 'call_ended_all', { callId });
      }
    } catch (err) {
      console.error('call_leave error:', err);
    }
  });


  // Called when the caller ends the call for everyone
  socket.on('call_end_all', async ({ callId }) => {
    try {
      // Find the call and verify that the requester is the caller
      const call = await prisma.call.findUnique({ where: { id: callId }, select: { callerId: true, conversationId: true, startedAt: true } });
      if (!call || call.callerId !== userId) return;
      // Mark all participants as ended and set call.endedAt
      await prisma.$transaction([
        prisma.callParticipant.updateMany({ where: { callId, status: { in: ['ACTIVE', 'RINGING'] } }, data: { status: 'ENDED', leftAt: new Date() } }),
        prisma.call.update({ where: { id: callId }, data: { endedAt: new Date() } }),
      ]);
      // Add system message "Call ended"      
      await createCallSystemMessage(call.conversationId, `📞 Call ended`);
      // Emit call_ended_all to the conversation room so clients can close the call UI
      io.to(`conversation:${call.conversationId}`).emit('call_ended_all', { callId });
    } catch (err) { 
      console.error('call_end_all error:', err);
    }
  });
};




// // --- WebRTC Signaling (If we used WebRTC for voice/video calls) move this block inside handleChatEvents() ──────────────────────────────
// socket.on('call_user', ({ conversationId, offer, callType }) => {
//   // callType: 'video' | 'audio'
//   socket.to(`conversation:${conversationId}`).emit('incoming_call', {
//     from: userId, conversationId, offer, callType
//   });
// });

// socket.on('call_answer', ({ conversationId, answer }) => {
//   socket.to(`conversation:${conversationId}`).emit('call_answered', { answer });
// });

// socket.on('ice_candidate', ({ conversationId, candidate }) => {
//   socket.to(`conversation:${conversationId}`).emit('ice_candidate', { candidate });
// });

// socket.on('call_end', ({ conversationId }) => {
//   socket.to(`conversation:${conversationId}`).emit('call_ended', { by: userId });
// });

// socket.on('call_reject', ({ conversationId }) => {
//   socket.to(`conversation:${conversationId}`).emit('call_rejected', { by: userId });
// });


