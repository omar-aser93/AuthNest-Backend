import { prisma } from '../prisma.js';
import { AccessToken } from 'livekit-server-sdk';
import { uploadToCloudinary, deleteFromCloudinary } from '../utils/uploadToCloudinary.js';
import { deleteMessagesCascade } from "../utils/cascadeDelete.js";
import { getIO } from '../socket/index.js';
import { sanitizeText } from '../utils/XSS-sanitization.js';
import fs from 'fs';

// Reusable prisma query (include) shape for messages — keeps emitted socket shape & REST response consistent
const messageInclude = {
  sender: { select: { id: true, name: true, image: true } },
  attachments: true,
  reactions: { include: { user: { select: { id: true, name: true, image: true } } } },
  reads: { include: { user: { select: { id: true, name: true, image: true } } } },
  tags: { include: { tagged: { select: { id: true, name: true, image: true } } } },
  editHistory: { select: { id: true } },
};



// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATIONS
// ─────────────────────────────────────────────────────────────────────────────

// ---------------- GET ALL CONVERSATIONS CONTROLLER ----------------
export async function getConversations(req, res, next) {
  try {
    const userId = req.user.id;   // get current user id from token (req.user is set by auth middleware)

    // Find all conversations the user participates in, ordered by most recent activity
    const participations = await prisma.conversationParticipant.findMany({
      where: { userId },
      include: {
        conversation: {
          include: {
            participants: { include: { user: { select: { id: true, name: true, image: true } }} },
            // Include only the last message for conversation preview
            messages: { orderBy: { createdAt: 'desc' }, take: 1, include: { sender: { select: { id: true, name: true } }, attachments: { select: { fileType: true, fileName: true } }}, },
          },
        },
      },
      orderBy: { conversation: { lastMessageAt: 'desc' } },
    });
    
    const conversations = participations.map(p => p.conversation);  // Extract conversations from participations array
    res.json({ conversations });             // respond with the list of conversations
  } catch (err) { next(err); }               // if error, pass to error handler
}



// ---------------- GET OR CREATE DM CONTROLLER ----------------
export async function getOrCreateDM(req, res, next) {
  try {
    const userId = req.user.id;           // get current user id from token (req.user is set by auth middleware)
    const { targetUserId } = req.body;    // get target user id from request body

    // Check if targetUserId is provided & is not the same as current user
    if (!targetUserId) return res.status(400).json({ message: 'targetUserId is required' });
    if (targetUserId === userId) return res.status(400).json({ message: 'Cannot DM yourself' });

    // Check if target user exists
    const targetUser = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
    if (!targetUser) return res.status(404).json({ message: 'User not found' });

    // Check if a DM between these two users already exists
    const existing = await prisma.conversation.findFirst({
      where: { isGroup: false, AND: [ { participants: { some: { userId } } }, { participants: { some: { userId: targetUserId } } } ] },
      include: { participants: { include: { user: { select: { id: true, name: true, image: true } }} } },
    });
    // If it exists, return it instead of creating a new one
    if (existing) return res.json({ conversation: existing, created: false });

    // Create new DM conversation
    const conversation = await prisma.conversation.create({
      data: { isGroup: false, participants: { create: [{ userId }, { userId: targetUserId }] } },
      include: { participants: { include: { user: { select: { id: true, name: true, image: true } }} } },
    });

    // Tell both users' sockets to join the new room (handles case where they're online)
    const io = getIO();
    io?.to(`user:${userId}`).emit('join_new_conversation', { conversationId: conversation.id });
    io?.to(`user:${targetUserId}`).emit('join_new_conversation', { conversationId: conversation.id });

    res.status(201).json({ conversation, created: true });   // respond with the new conversation
  } catch (err) { next(err); }                               // if error, pass to error handler
}



// ---------------- CREATE GROUP CONTROLLER ----------------
export async function createGroup(req, res, next) {
  try {
    const userId = req.user.id;                  // get current user id from token (req.user is set by auth middleware)
    const { name, participantIds } = req.body;   // get group name and participant ids from request body
    
    // Verify group name and participants
    if (!name?.trim()) return res.status(400).json({ message: 'Group name is required' });
    if (!Array.isArray(participantIds) || participantIds.length === 0) {
      return res.status(400).json({ message: 'At least one other participant is required' });
    }

    // Deduplicate and always include the creator
    const allIds = [...new Set([userId, ...participantIds])];

    // Verify all participants exist
    const users = await prisma.user.findMany({ where: { id: { in: allIds } }, select: { id: true } });
    if (users.length !== allIds.length) return res.status(400).json({ message: 'One or more users not found' });

    // Create new group conversation with all participants
    const conversation = await prisma.conversation.create({
      data: { isGroup: true, name: name.trim(), participants: { create: allIds.map(id => ({ userId: id })) } },
      include: { participants: { include: { user: { select: { id: true, name: true, image: true } }} } },
    });

    // Tell all participants' sockets to join the new room
    const io = getIO();
    allIds.forEach(id => {
      io?.to(`user:${id}`).emit('join_new_conversation', { conversationId: conversation.id });
    });

    res.status(201).json({ conversation });        // respond with the new conversation
  } catch (err) { next(err); }                     // if error, pass to error handler
}



// ---------------- GET SINGLE CONVERSATION CONTROLLER ----------------
export async function getConversation(req, res, next) {
  try {
    const userId = req.user.id;            // get current user id from token (req.user is set by auth middleware)

    // find the conversation by id, but only if the current user is a participant (security check)
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, participants: { some: { userId } } },
      include: { participants: { include: { user: { select: { id: true, name: true, image: true } }} } },
    });

    // if no conversation found, return 404
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
    res.json({ conversation });        // respond with the conversation details
  } catch (err) { next(err); }         // if error, pass to error handler
}



// ---------------- UPDATE GROUP CONTROLLER ----------------
export async function updateGroup(req, res, next) {
  try {
    const userId = req.user.id;          // get current user id from token (req.user is set by auth middleware)
    const { name } = req.body;           // get new group name from request body (currently only allowing name update here — can extend to other fields later)

    // find the conversation by id, but only if it's a group and the current user is a participant (security check)
    const conversation = await prisma.conversation.findFirst({ where: { id: req.params.id, isGroup: true, participants: { some: { userId } } } });
    // if no conversation found, return 404
    if (!conversation) return res.status(404).json({ message: 'Group not found' });

    // update the group name (only if provided and not just whitespace)
    const updated = await prisma.conversation.update({
      where: { id: req.params.id },
      data: { ...(name?.trim() && { name: name.trim() }) },
      include: { participants: { include: { user: { select: { id: true, name: true, image: true } }} } },
    });

    // Broadcast group update to all members
    const io = getIO();
    io?.to(`conversation:${updated.id}`).emit('conversation_updated', updated);

    res.json({ conversation: updated });         // respond with the updated conversation details
  } catch (err) { next(err); }                   // if error, pass to error handler
}



// ---------------- ADD PARTICIPANTS CONTROLLER ----------------
export async function addParticipants(req, res, next) {
  try {
    const userId = req.user.id;                // get current user id from token (req.user is set by auth middleware)
    const { userIds } = req.body;              // get array of user ids to add from request body

    // Verify user ids
    if (!Array.isArray(userIds) || userIds.length === 0) { return res.status(400).json({ message: 'userIds array is required' }) }

    // find the conversation by id, but only if it's a group and the current user is a participant (security check)
    const conversation = await prisma.conversation.findFirst({ where: { id: req.params.id, isGroup: true, participants: { some: { userId } } } });
    // if no conversation found, return 404
    if (!conversation) return res.status(404).json({ message: 'Group not found' });

    // Add new participants (skipDuplicates prevents errors if already in group) - Commented version works with postgres only
    // await prisma.conversationParticipant.createMany({
    //   data: userIds.map(id => ({ userId: id, conversationId: req.params.id })),
    //   skipDuplicates: true,
    // });
    await Promise.all(
      userIds.map(id =>
        prisma.conversationParticipant.upsert({
          where: { userId_conversationId: { userId: id, conversationId: req.params.id } },
          update: {},   // already a participant — no update needed
          create: { userId: id, conversationId: req.params.id },
        })
      )
    );

    // Find the updated conversation
    const updated = await prisma.conversation.findUnique({
      where: { id: req.params.id },
      include: { participants: { include: { user: { select: { id: true, name: true, image: true } }} } },
    });

    // Tell newly added users to join the socket room
    const io = getIO();
    userIds.forEach(id => { io?.to(`user:${id}`).emit('join_new_conversation', { conversationId: req.params.id }) });
    // Notify existing room members about new participants
    io?.to(`conversation:${req.params.id}`).emit('participants_updated', updated);

    res.json({ conversation: updated });        // respond with the updated conversation details
  } catch (err) { next(err); }                  // if error, pass to error handler
}



// ---------------- REMOVE PARTICIPANT CONTROLLER ----------------
export async function removeParticipant(req, res, next) {
  try {
    const userId = req.user.id;             // get current user id from token (req.user is set by auth middleware)
    const conversationId = req.params.id;   // get conversation id from params (/messages/:id)
    const { targetUserId } = req.body;      // if omitted, the current user is leaving

    const removeId = targetUserId || userId;   // leave self or remove another user

    // Verify the conversation exists and current user is a participant
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, isGroup: true, participants: { some: { userId } } } });
    // if no group conversation found, return 404
    if (!conversation) return res.status(404).json({ message: 'Group not found' });

    // Non-admin removing someone else is not allowed (basic rule — extend with admin role later)
    if (targetUserId && targetUserId !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to remove other participants' });
    }

    // Remove the participant in the DB
    await prisma.conversationParticipant.deleteMany({ where: { conversationId, userId: removeId } });

    // Tell removed user's socket to leave the room
    const io = getIO();
    io?.to(`user:${removeId}`).emit('removed_from_conversation', { conversationId });
    // Notify remaining members
    io?.to(`conversation:${conversationId}`).emit('participant_left', { userId: removeId, conversationId });

    res.json({ message: 'Participant removed' });        // respond with success message
  } catch (err) { next(err); }                           // if error, pass to error handler
}



// ---------------- DELETE CONVERSATION (soft delete for current user) ----------------
// For DMs: removes the current user as participant (hides it from their list)
// For groups: same as leaving — We use removeParticipant controller instead
export async function deleteConversation(req, res, next) {
  try {
    const userId = req.user.id;               // get current user id from token (req.user is set by auth middleware) 
    const conversationId = req.params.id;     // get conversation id from params (/messages/:id)

    // Verify user is a participant
    const participant = await prisma.conversationParticipant.findUnique({ where: { userId_conversationId: { userId, conversationId } } });
    if (!participant) return res.status(404).json({ message: 'Conversation not found' });

    // Remove the participant in the DB
    await prisma.conversationParticipant.deleteMany({ where: { conversationId, userId } });

    // Tell removed user's socket to leave the room
    const io = getIO();
    io?.to(`user:${userId}`).emit('removed_from_conversation', { conversationId });

    res.json({ message: 'Conversation deleted' });        // respond with success message
  } catch (err) { next(err); }                            // if error, pass to error handler
}



// ---------------- GET UNREAD COUNTS FOR ALL CONVERSATIONS ----------------
export async function getUnreadCounts(req, res, next) {
  try {
    const userId = req.user.id;            // Get current user id from token (req.user is set by auth middleware)

    // Get all conversations the user is in
    const participations = await prisma.conversationParticipant.findMany({ where: { userId }, select: { conversationId: true } });
    const conversationIds = participations.map(p => p.conversationId);

    // Count unread messages per conversation (not from self, not read)
    const unreadMap = {};
    for (const convId of conversationIds) {
      const count = await prisma.message.count({
        where: { conversationId: convId, senderId: { not: userId }, reads: { none: { userId } }, }
      });
      if (count > 0) unreadMap[convId] = count;
    }

    res.json({ unreadMap });               // respond with the count
  } catch (err) { next(err); }             // if error, pass to error handler 
}



// ─────────────────────────────────────────────────────────────────────────────
// MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

// ---------------- GET MESSAGES CONTROLLER (cursor-based pagination) ----------------
export async function getMessages(req, res, next) {
  try {
    const userId = req.user.id;                 // get current user id from token (req.user is set by auth middleware)
    const conversationId = req.params.id;       // get conversation id from request params (/messages/:id)
    const limit = Math.min(parseInt(req.query.limit) || 30, 50);     // cap at 50
    const cursor = req.query.cursor;   // message id to paginate from

    // Verify user is a participant
    const participant = await prisma.conversationParticipant.findUnique({ where: { userId_conversationId: { userId, conversationId } } });
    if (!participant) return res.status(403).json({ message: 'Not a participant' });

    // Resolve cursor to a timestamp for reliable pagination
    let cursorDate;
    if (cursor) {
      const cursorMessage = await prisma.message.findUnique({ where: { id: cursor }, select: { createdAt: true } });
      if (cursorMessage) cursorDate = cursorMessage.createdAt;
    }

    // Fetch messages newest-first (we reverse before responding to get chronological order)
    const messages = await prisma.message.findMany({
      where: { conversationId, ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}) },
      include: messageInclude,                // include sender, attachments, reactions...etc
      orderBy: { createdAt: 'desc' },         // newest first
      take: limit,                            // limit to 30
    });

    // Reverse to chronological (oldest → newest) for the frontend
    const ordered = [...messages].reverse();

    // nextCursor is the oldest message's id — client passes it to load the next page upward
    const nextCursor = messages.length === limit ? messages[messages.length - 1].id : null;

    res.json({ messages: ordered, nextCursor });     // respond with messages and nextCursor for pagination
  } catch (err) { next(err); }                       // if error, pass to error handler
}



// ---------------- SEND MESSAGE WITH ATTACHMENTS CONTROLLER ----------------
// Used when message has files — text-only messages go through socket for speed
export async function sendMessageWithAttachments(req, res, next) {
  try {
    const userId = req.user.id;                 // get current user id from token (req.user is set by auth middleware)
    const conversationId = req.params.id;       // get conversation id from request params (/messages/:id)
    const content = req.body.content ? sanitizeText(req.body.content) : null;  // sanitize text to prevent XSS, allow null for attachment-only messages
    const taggedUserIds = req.body.taggedUserIds ? [req.body.taggedUserIds].flat() : [];  // ensure taggedUserIds is an array  
    const files = req.files || [];    // get files from multer (array of files, empty if no files)

    // Validate that message has either content or at least one attachment
    if (!content && files.length === 0) { return res.status(400).json({ message: 'Message must have content or attachments' }); }

    // Verify user is a participant, if not, return 403 Forbidden 
    const participant = await prisma.conversationParticipant.findUnique({ where: { userId_conversationId: { userId, conversationId } }});
    if (!participant) return res.status(403).json({ message: 'Not a participant' });

    // Upload all files to Cloudinary, clean up temp files after each upload
    const uploadedAttachments = [];
    for (const file of files) {
      try {
        const result = await uploadToCloudinary(file.path, 'chat_attachments');
        if (!result?.url) throw new Error(`Upload failed for ${file.originalname}`);
        uploadedAttachments.push({
          url: result.url,
          publicId: result.publicId,
          fileType: file.mimetype.split('/')[0],   // 'image', 'video', 'application'
          fileName: file.originalname,
          fileSize: file.size,
        });
      } finally {
        // Always clean up temp file even if Cloudinary upload fails
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      }
    }

    // Create message + attachments + tags in one transaction
    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: { content, conversationId, senderId: userId,
                attachments: uploadedAttachments.length > 0 ? { create: uploadedAttachments } : undefined,
                tags: taggedUserIds.length > 0 ? { create: taggedUserIds.map(taggedId => ({ taggedId, taggedById: userId })) } : undefined,
        },
        include: messageInclude,
      });

      // Update conversation last activity
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });

      return created;          // return created message
    });

    // Broadcast via socket so all participants receive it in real time
    // (same event as text-only send_message so frontend handles both identically)
    const io = getIO();
    io?.to(`conversation:${conversationId}`).emit('new_message', message);

    res.status(201).json({ message });        // respond with created message
  } catch (err) { next(err); }                // if error, pass to error handler
}



// ---------------- SEND GIF CONTROLLER ----------------
export async function sendGif(req, res, next) {
  try {
    const userId = req.user.id;             // get current user id from token
    const conversationId = req.params.id;   // get conversation id from request params
    const { url } = req.body;               // get gif url from request body

    // Validate Klipy CDN URL (adjust hostname if Klipy uses a different CDN domain)
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ message: "Invalid GIF URL" });
    }
    if ( parsed.protocol !== "https:" || !/(^|\.)klipy\.com$/.test(parsed.hostname)) {
      return res.status(400).json({ message: "Invalid GIF URL" });
    }

    // Verify user is a participant
    const participant = await prisma.conversationParticipant.findUnique({ where: { userId_conversationId: { userId, conversationId } } });
    if (!participant) return res.status(403).json({ message: "Not a participant" });
   
    // Create the message in one transaction
    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: { conversationId, senderId: userId, content: null,   
          attachments: {
            create: [{
              url,
              publicId: "",        // empty — not in Cloudinary
              fileType: "image",
              fileName: "gif.gif",
              fileSize: 0,
            }],
          },
        },
        include: messageInclude,
      });
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
      return created;
    });
    // Broadcast via socket
    getIO()?.to(`conversation:${conversationId}`).emit("new_message", message);
    res.status(201).json({ message });    // respond with created message
  } catch (err) { next(err); }            // if error, pass to error handler
}



// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE ACTIONS
// ─────────────────────────────────────────────────────────────────────────────

// ---------------- EDIT MESSAGE CONTROLLER ----------------
export async function editMessage(req, res, next) {
  try {
    const userId = req.user.id;                        // get current user id from token (req.user is set by auth middleware)
    const { messageId } = req.params;                  // get message id from request params (/messages/:id)
    const { content, taggedUserIds = [] } = req.body;  // get content and taggedUserIds from request body
    const cleanContent = content ? sanitizeText(content) : null;  // sanitize text to prevent XSS

    // Validate that content is not empty (can allow null if we want to support attachment-only messages, but for editing we require some content)
    if (!cleanContent) return res.status(400).json({ message: 'Content cannot be empty' });

    // Verify message exists and user is the sender
    const existing = await prisma.message.findFirst({ where: { id: messageId, senderId: userId }, include: { tags: true } });
    if (!existing) return res.status(404).json({ message: 'Message not found or not authorized' });

    // Get existing tagged user IDs
    const existingTaggedIds = existing.tags.map(t => t.taggedId);
    // Ensure taggedUserIds is an array (e.g., from FormData)
    let taggedUsersArray = taggedUserIds;
    if (typeof taggedUserIds === 'string') { taggedUsersArray = [taggedUserIds] }
    // Remove current user from tagged user IDs (user can't tag themselves)
    const uniqueTaggedUsers = [...new Set(taggedUsersArray)].filter(id => id !== userId);
    // Get tagged user IDs to add and remove
    const toAdd = uniqueTaggedUsers.filter(id => !existingTaggedIds.includes(id));
    const toRemove = existingTaggedIds.filter(id => !uniqueTaggedUsers.includes(id));

    // Update message transaction
    const updated = await prisma.$transaction(async (tx) => {
      // Save old content to edit history before overwriting
      await tx.editHistory.create({ data: { messageId, editorId: userId, oldContent: existing.content || '', newContent: cleanContent } });
      // update message with recieved content  
      await tx.message.update({ where: { id: messageId }, data: { content: cleanContent } });
      // Handle tags
      if (toRemove.length) { await tx.tag.deleteMany({ where: { messageId, taggedId: { in: toRemove } } }) }
      for (const taggedId of toAdd) {
        const userExists = await tx.user.findUnique({ where: { id: taggedId }, select: { id: true } });
        if (userExists) {
          await tx.tag.create({ data: { messageId, taggedId, taggedById: userId } });
            // Optionally send TAG notifications if needed
            // await createNotification('TAG', { ... });            
          }
        }

      // 4. Fetch the final message with all includes (including updated tags)
      return tx.message.findUnique({ where: { id: messageId }, include: messageInclude });
    });

    // Broadcast edit to conversation room
    const io = getIO();
    io?.to(`conversation:${existing.conversationId}`).emit('message_edited', updated);

    res.json({ message: updated });     // respond with updated message
  } catch (err) { next(err); }          // if error, pass to error handler
}



// ---------------- DELETE MESSAGE CONTROLLER (hard delete) ----------------
// Deletes the message record entirely along with all related data and Cloudinary files.
// For soft delete (a null content & kept record), use the socket delete_message event instead.
export async function deleteMessage(req, res, next) {
  try {
    const userId = req.user.id;             // get current user id from token (req.user is set by auth middleware)
    const { messageId } = req.params;       // get message id from request params (/messages/:id)

    // Admin can delete any message, others can only delete their own
      const existing = await prisma.message.findFirst({
      where: { id: messageId, ...(req.user.role !== 'admin' ? { senderId: userId } : {}) },
      select: { id: true, conversationId: true },
    });
    if (!existing) return res.status(404).json({ message: 'Message not found or not authorized' });

    // Cascade Delete message + children (attachments, reads, reactions, tags, editHistory), using the helper
    await prisma.$transaction(async (tx) => {
      await deleteMessagesCascade(tx, [existing.id], deleteFromCloudinary);
    });

    // Broadcast hard deletion to conversation room
    getIO()?.to(`conversation:${existing.conversationId}`).emit('message_deleted', {
      messageId,
      conversationId: existing.conversationId,
    });

    res.json({ message: 'Message deleted' });         // respond with success message
  } catch (err) { next(err); }                        // if error, pass to error handler
}



// ─────────────────────────────────────────────────────────────────────────────
// Generate Video/Audio Call Token (LiveKit)
// ─────────────────────────────────────────────────────────────────────────────
export async function generateCallToken(req, res, next) {
  try {
    const { conversationId } = req.body;       // get conversation id from request body
    const userId = req.user.id;                // get current user id from token (req.user is set by auth middleware)

    // Verify user is a participant, return error if not
    const participant = await prisma.conversationParticipant.findUnique({ where: { userId_conversationId: { userId, conversationId } }, include: { user: { select: { name: true } } } });
    if (!participant) return res.status(403).json({ message: 'Not a participant' });

    // Generate LiveKit token
    const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity: userId,
      name: participant.user.name,
      ttl: 60 * 60,  // token valid for 1 hour  
    });

    // Room name = conversationId (one room per conversation)
    token.addGrant({ roomJoin: true, room: conversationId, canPublish: true, canSubscribe: true });

    res.json({ token: await token.toJwt(), url: process.env.LIVEKIT_URL });    // respond with the token and LiveKit server URL
  } catch (err) { next(err); }            // if error, pass to error handler
}