import { prisma } from '../prisma.js';
import { canUserViewPost, getFriendIdsCached, getBlockedUserIdsCached } from '../utils/privacy.js';
import { createNotification } from '../utils/notificationHelper.js';
import { recalculateMessageSummary } from '../utils/messageReactionHelper.js';
import { getIO } from '../socket/index.js';


// ---------------- REACT TO POST CONTROLLER ----------------
export async function reactToPost(req, res, next) {
  try {
    const { postId } = req.params;           // Get post id from URL params
    const { type } = req.body;               // Get reaction type from request body
    const userId = req.user.id;              // Get current user id, from req.user (token payload)

    // Get post from db, if not found return 404 "Post not found"
    const post = await prisma.post.findUnique({ where: { id: postId }, include: { author: true }});
    if (!post) { return res.status(404).json({ message: "Post not found" }); }

    // Setting the privacy utility for the post:
    const friendIds = userId ? await getFriendIdsCached(userId) : [];        // get friends IDs (cached) for current user 
    const blockedIds = userId ? await getBlockedUserIdsCached(userId) : [];  // get blocked users IDs (cached) for current user
    // Check if user can view this post, if not return 403 'You cannot react to this post'
    if (!canUserViewPost(post, userId, friendIds, blockedIds)) { return res.status(403).json({ message: "You cannot react to this post" }); }

    // Check for existing reaction
    const existingReaction = await prisma.reaction.findUnique({ where: { userId_postId: { userId, postId } }});

    let reaction;              // Variable to Store the Reaction object    
    if (existingReaction) {     
      // If reaction already exists & is of the same reaction type 
      if (existingReaction.type === type) {
        // Same reaction - remove it (toggle off)
        await prisma.reaction.delete({ where: { userId_postId: { userId, postId } } });        
        // Decrement post reaction count (We use this method instead of [$count or .length] for better performance for large datasets)
        await prisma.post.update({ where: { id: postId }, data: { reactionCount: { decrement: 1 } } });
        // Return with success message and null reaction
        return res.json({ message: "Reaction removed", reaction: null });
      } else {
        // Exists & Different reaction type - update it
        reaction = await prisma.reaction.update({ where: { userId_postId: { userId, postId } }, data: { type }});
      }
    } else {
      // If reaction doesn't exist - Create new reaction
      reaction = await prisma.reaction.create({ data: { userId, postId, type } });
      // Increment post reaction count
      await prisma.post.update({ where: { id: postId }, data: { reactionCount: { increment: 1 } } });
      // Create notification if not reacting to own post, using the notification helper
      if (post.authorId !== userId) { await createNotification('REACTION', { userId: post.authorId, senderId: userId, postId, reactionType: type }) }}

    // Return with success message and the reaction  
    res.json({ message: existingReaction ? "Reaction updated" : "Reaction added", reaction });
  } catch (err) { next(err); }         // catch errors and pass to error handler
}



// ---------------- REMOVE POST REACTION CONTROLLER ----------------
export async function removePostReaction(req, res, next) {
  try {
    const { postId } = req.params;                    // Get post id from URL params
    const userId = req.user.id;                       // Get current user id, from req.user (token payload)

    // Delete reaction, if not found return 404 "Reaction not found"
    const reaction = await prisma.reaction.delete({ where: { userId_postId: { userId, postId } }});
    if (!reaction) { return res.status(404).json({ message: "Reaction not found" }); }

    // Decrement post reaction count (We use this method instead of [$count or .length] for better performance for large datasets)
    await prisma.post.update({ where: { id: postId }, data: { reactionCount: { decrement: 1 } } });

    res.json({ message: "Reaction removed" });        // Return with success message
  } catch (err) { next(err); }                        // catch errors and pass to error handler
}



// ---------------- REACT TO COMMENT CONTROLLER ----------------
export async function reactToComment(req, res, next) {
  try {
    const { commentId } = req.params;               // Get comment id from URL params
    const { type } = req.body;                      // Get reaction type from request body
    const userId = req.user.id;                     // Get current user id, from req.user (token payload)

    // Get comment with post info, if not found return 404 "Comment not found"
    const comment = await prisma.comment.findUnique({ where: { id: commentId }, include: { user: true, post: { include: { author: true } } }});
    if (!comment) { return res.status(404).json({ message: "Comment not found" }); }
   
    // Setting the privacy utility for the post:
    const friendIds = userId ? await getFriendIdsCached(userId) : [];  // get friends IDs (cached) for current user 
    const blockedIds = userId ? await getBlockedUserIdsCached(userId) : [];  // get blocked users IDs (cached) for current user
    // Check if user can view this post, if not return 403 'You cannot react to this comment'
    if (!canUserViewPost(comment.post, userId, friendIds, blockedIds)) { return res.status(403).json({ message: "You cannot react to this comment" }); }

    // Check for existing reaction
    const existingReaction = await prisma.commentReaction.findUnique({ where: { userId_commentId: { userId, commentId } } });

    let reaction;              // Variable to Store the Reaction object    
    if (existingReaction) {
      // If reaction already exists & is of the same reaction type
      if (existingReaction.type === type) {
        // Same reaction - remove it (toggle off)
        await prisma.commentReaction.delete({ where: { userId_commentId: { userId, commentId } } });
        // Return with success message and null reaction
        return res.json({ message: "Reaction removed", reaction: null });
      } else {
        // Exists & Different reaction - update it
        reaction = await prisma.commentReaction.update({ where: { userId_commentId: { userId, commentId } }, data: { type } });
      }
    } else {
      // If reaction doesn't exist - Create new reaction
      reaction = await prisma.commentReaction.create({ data: { userId, commentId, type }});
      // Create notification if not reacting to own comment, using the notification utility function
      if (comment.userId !== userId) { await createNotification('REACTION', { userId: comment.userId, senderId: userId, commentId, postId: comment.postId, reactionType: type }); } }

    // Return with success message and the reaction
    res.json({ message: existingReaction ? "Reaction updated" : "Reaction added", reaction });
  } catch (err) { next(err); }              // catch errors and pass to error handler
}



// ---------------- REMOVE COMMENT REACTION CONTROLLER ----------------
export async function removeCommentReaction(req, res, next) {
  try {
    const { commentId } = req.params;               // Get comment id from URL params
    const userId = req.user.id;                     // Get current user id, from req.user (token payload)

    // Delete reaction, if not found return 404 "Reaction not found"
    const reaction = await prisma.commentReaction.delete({ where: { userId_commentId: { userId, commentId } } });
    if (!reaction) { return res.status(404).json({ message: "Reaction not found" }); }

    res.json({ message: "Reaction removed" });        // Return with success message
  } catch (err) { next(err); }                        // catch errors and pass to error handler
}



// ---------------- REACT TO MESSAGE CONTROLLER ----------------
export async function reactToMessage(req, res, next) {
  try {
    const { messageId } = req.params;               // Get message id from URL params
    const { type } = req.body;                      // Get reaction type from request body
    const userId = req.user.id;                     // Get current user id from token

    // Verify message exists  
    const message = await prisma.message.findUnique({ where: { id: messageId }, include: { conversation: { include: { participants: { select: { userId: true } } } } } });
    if (!message) { return res.status(404).json({ message: "Message not found" }); }

    // Check if user is a participant of the conversation this message belongs to
    const isParticipant = message.conversation.participants.some(p => p.userId === userId);
    if (!isParticipant) { return res.status(403).json({ message: "You cannot react to this message" }); }

    // Check for existing reaction
    const existingReaction = await prisma.messageReaction.findUnique({ where: { userId_messageId: { userId, messageId } } });

    let reaction;                // Variable to Store the Reaction object
    if (existingReaction) {
      // If reaction already exists & is of the same reaction type
      if (existingReaction.type === type) {
        // Same reaction — toggle off (remove)
        await prisma.messageReaction.delete({ where: { userId_messageId: { userId, messageId } } });
        // Recalculate summary Helper (keeps reactionSummary field in sync)
        const { summary, count } = await recalculateMessageSummary(messageId);
        // Broadcast removal to room
        getIO()?.to(`conversation:${message.conversationId}`).emit('message_reaction_updated', {
          messageId, conversationId: message.conversationId, summary, count
        });        
        return res.json({ message: "Reaction removed", reaction: null, summary });
      } else {
        // Different reaction type — update it
        reaction = await prisma.messageReaction.update({ where: { userId_messageId: { userId, messageId } }, data: { type } });
      }
    } else {
      // No existing reaction — create new
      reaction = await prisma.messageReaction.create({ data: { userId, messageId, type } });
    }

    // Recalculate summary Helper, keeps reactionSummary field in sync after add/update
    const { summary, count } = await recalculateMessageSummary(messageId);
    // Broadcast updated summary to conversation room
    getIO()?.to(`conversation:${message.conversationId}`).emit('message_reaction_updated', {
      messageId, conversationId: message.conversationId, summary, count
    });

    res.json({ message: existingReaction ? "Reaction updated" : "Reaction added", reaction, summary });
  } catch (err) { next(err); }          // catch errors and pass to error handler
}



// ---------------- REMOVE MESSAGE REACTION CONTROLLER ----------------
export async function removeMessageReaction(req, res, next) {
  try {
    const { messageId } = req.params;               // Get message id from URL params
    const userId = req.user.id;                     // Get current user id from token

    // Verify message exists 
    const message = await prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true } });
    if (!message) return res.status(404).json({ message: "Message not found" });

    // Delete — will throw P2025 if record doesn't exist, caught by next(err)
    await prisma.messageReaction.delete({ where: { userId_messageId: { userId, messageId } } });

    // Recalculate summary Helper
    const { summary, count } = await recalculateMessageSummary(messageId);
    // Broadcast to conversation room
    getIO()?.to(`conversation:${message.conversationId}`).emit('message_reaction_updated', {
      messageId, conversationId: message.conversationId, summary, count
    });

    res.json({ message: "Reaction removed", summary });  // Return with success message & updated summary
  } catch (err) { next(err); }
}    
