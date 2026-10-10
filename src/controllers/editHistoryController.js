import { prisma } from '../prisma.js';


// ---------------- GET POST EDIT HISTORY CONTROLLER ----------------
export async function getPostEditHistory(req, res, next) {
  try {
    
    // Check if post exists, if not return 404 "Post not found"
    const post = await prisma.post.findUnique({ where: { id: req.params.postId }, select: { authorId: true } });
    if (!post) { return res.status(404).json({ message: "Post not found" }); }

    // Only author or admin can view edit history
    if (post.authorId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: "Not authorized to view edit history" });
    }

    // Get edit history for the post by its id (descending order), include user needed info (related model)
    const edits = await prisma.editHistory.findMany({
      where: { postId: req.params.postId },
      orderBy: { editedAt: 'desc' },
      include: { editor: { select: { id: true, name: true, image: true } } }
    });

    res.json({ edits });              // respond with edit history
  } catch (err) { next(err); }        // catch errors and pass to error handler
}



// ---------------- GET COMMENT EDIT HISTORY CONTROLLER ----------------
export async function getCommentEditHistory(req, res, next) {
  try {     

    // Check if comment exists, if not return 404 "Comment not found"
    const comment = await prisma.comment.findUnique({ where: { id: req.params.commentId }, select: { userId: true } });
    if (!comment) { return res.status(404).json({ message: "Comment not found" }); }

    // Only comment author or admin can view edit history
    if (comment.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: "Not authorized to view edit history" });
    }    

    // Get edit history for the comment by its id (descending order), include user needed info (related model)
    const edits = await prisma.editHistory.findMany({
      where: { commentId: req.params.commentId },
      orderBy: { editedAt: 'desc' },
      include: { editor: { select: { id: true, name: true, image: true } } }
    });

    res.json({ edits });               // respond with edit history
  } catch (err) { next(err); }         // catch errors and pass to error handler
}



// ---------------- GET MESSAGE EDIT HISTORY CONTROLLER ----------------
export async function getMessageEditHistory(req, res, next) {
  try {

    // Check if message exists, if not return 404 "Message not found"
    const message = await prisma.message.findUnique({
      where: { id: req.params.messageId },
      include: { conversation: { include: { participants: { select: { userId: true } } } } }
    });
    if (!message) { return res.status(404).json({ message: "Message not found" }); }

    // Only the sender, a conversation participant, or admin can view message edit history
    const isParticipant = message.conversation.participants.some(p => p.userId === req.user.id);
    const isSender = message.senderId === req.user.id;
    if (!isSender && !isParticipant && req.user.role !== 'admin') {
      return res.status(403).json({ message: "Not authorized to view edit history" });
    }

    // Get edit history for the message (descending order), include editor info
    const edits = await prisma.editHistory.findMany({
      where: { messageId: req.params.messageId },
      orderBy: { editedAt: 'desc' },
      include: { editor: { select: { id: true, name: true, image: true } } }
    });

    res.json({ edits });                // respond with edit history
  } catch (err) { next(err); }          // catch errors and pass to error handler
}