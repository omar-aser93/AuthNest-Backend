import { prisma } from "../prisma.js";
import { canUserViewPost, getFriendIdsCached, getBlockedUserIdsCached } from '../utils/privacy.js';
import { createNotification } from '../utils/notificationHelper.js';
import { deleteCommentsCascade, collectCommentDescendants } from "../utils/cascadeDelete.js";
import { sanitizeText } from "../utils/XSS-sanitization.js";


// ---------------- Get comments for a post controller ------------------
export async function getPostComments(req, res, next) {
  try {
    const { postId } = req.params;                     // get the post id from params
    const limit = parseInt(req.query.limit) || 10;     // get limit from URL query OR default to 10
    const cursor = req.query.cursor;                   // get cursor from URL query (for infinite scroll)
    const parentId = req.query.parentId || null;       // For nested comments (replies)

    // Check if post exists, if not return 404 "Post not found"
    const post = await prisma.post.findUnique({ where: { id: postId } });    
    if (!post) { return res.status(404).json({ message: "Post not found" }); }

    // Setting the privacy utility for the post:
    const friendIds = req.user?.id ? await getFriendIdsCached(req.user.id) : [];        // get friends IDs (cached) for current user 
    const blockedIds = req.user?.id ? await getBlockedUserIdsCached(req.user.id) : [];  // get blocked users IDs (cached) for current user
    // Check if user can view this post, if not return 403 'You cannot view comments on this post'
    if (!canUserViewPost(post, req.user?.id, friendIds, blockedIds)) { return res.status(403).json({ message: "You cannot view comments on this post" }); }

    // fetch post comments from db (include user needed info -> a DB related model) + set pagination & order
    const comments = await prisma.comment.findMany({
      take: limit + 1,                                    // +1 to check if there are more comments after the limit
      skip: cursor ? 1 : 0,                               // skip the extra comment if there is a cursor
      cursor: cursor ? { id: cursor } : undefined,        // set the cursor indicator
      // replies in chronological, top-level in reverse chronological (newest first), this is common for comment sections. 
      orderBy: [{ createdAt: parentId ? "asc" : "desc" }, { id: parentId ? "asc" : "desc" }],        
      where: { postId, ...(parentId ? { parentId } : { OR: [{ parentId: null }, { parentId: { isSet: false } }] })},    
      include: { 
        user: { select: { id: true, name: true, image: true } }, 
        reactions: req.user?.id ? { where: { userId: req.user.id }, select: { type: true }} : false, 
        _count: { select: { editHistory: true } },       
      }
    });

    // if there are more comments than the limit, set next cursor 
    let nextCursor = null;
    if (comments.length > limit) { nextCursor = comments[limit-1].id; comments.pop(); }
    
    // Transform output to array of comments to include myReaction field (needed for UI to show current user's comment reaction without needing extra request) + isEdited
    const formatted = comments.map(comment => ({ ...comment, myReaction: comment.reactions?.[0]?.type || null, isEdited: comment._count?.editHistory > 0  }));
    res.json({ nextCursor, comments: formatted });    // respond with comments and next cursor (infinite scroll pagination)
  } catch (err) { next(err); }                        // catch errors and pass to error handler
}



// ------------ Create comment Controller ------------------
export async function createComment(req, res, next) {
  try {
    const { postId } = req.params;          // get the post id from params
    const userId = req.user.id;             // get current user id, from req.user (token payload)
    const { content, parentId, taggedUsers = [] } = req.body;          // extract fields from req.body 
    const cleanContent = content ? sanitizeText(content) : content;    // sanitize received content   
    
    // Check if post exists, if not return 404 "Post not found"
    const post = await prisma.post.findUnique({ where: { id: postId } });    
    if (!post) { return res.status(404).json({ message: "Post not found" }); }

    // Setting the privacy utility for the post:
    const friendIds = req.user?.id ? await getFriendIdsCached(req.user.id) : [];  // get friends IDs (cached) for current user 
    const blockedIds = req.user?.id ? await getBlockedUserIdsCached(req.user.id) : [];  // get blocked users IDs (cached) for current user
    // Check if user can view this post, if not return 403 'You cannot comment on this post'
    if (!canUserViewPost(post, userId, friendIds, blockedIds)) { return res.status(403).json({ message: "You cannot comment on this post" }); }

    // for adding nested replies: Check if parent comment exists
    if (parentId) {
      const parentComment = await prisma.comment.findUnique({ where: { id: parentId } });  
      // if not found return 404 "Parent comment not found"    
      if (!parentComment) { return res.status(404).json({ message: "Parent comment not found" }); }
      // check if the parent comment is in same post, if not return 400 "Parent comment is not in this post"
      if (parentComment.postId !== postId) { return res.status(400).json({ message: "Parent comment is not in this post" }); }
    }

    // create prisma transaction for multiple db operations (all or nothing)
    const result = await prisma.$transaction(async (tx) => {
      // 1. create comment in db, include user & post needed info (a DB related models)
      const comment = await tx.comment.create({
        data: { content: cleanContent, postId, userId, parentId },
        include: { user: { select: { id: true, name: true, image: true } }, post: { select: { id: true, title: true } } }  
      });

      // 2. increment comment count in the post (We use this method instead of [$count or .length] for better performance for large datasets)
      await tx.post.update({ where: { id: postId }, data: { commentCount: { increment: 1 } }});

      // 3. handle tagged users for the comment, if tagged users array provided
      const uniqueTaggedUsers = [...new Set(taggedUsers)].filter(id => id !== userId);  // Remove duplicates & self-tagging
      // for each tagged user, check if they exist in the db
      for (const taggedId of uniqueTaggedUsers) {
        const userExists = await tx.user.findUnique({ where: { id: taggedId }, select: { id: true } });
        // if tagged user exists, create a tag record for the comment, then send TAG notification using createNotification helper
        if (userExists) {
          const tag = await tx.tag.create({ data: { postId, commentId: comment.id, taggedId, taggedById: userId } });
          await createNotification('TAG', { userId: taggedId, senderId: userId, postId, commentId: comment.id, tagId: tag.id }); 
        }
      }

      // 4. send a 'COMMENT' notification to post author if they are not the comment author, using createNotification helper
      if (post.authorId !== userId) { await createNotification('COMMENT', { userId: post.authorId, senderId: userId, postId, commentId: comment.id }); }

      // 5. Check if this comment is a reply to another comment (it has a parentId)
      if (parentId) { 
        // increment reply count in the parent comment (We use this method instead of [$count or .length] for better performance for large datasets)
        await tx.comment.update({ where: { id: parentId }, data: { replyCount: { increment: 1 } } });
        // get the parent comment itself by parentId
        const parentComment = await tx.comment.findUnique({ where: { id: parentId }, select: { userId: true } });
        // if parent comment author is not the reply author, Send a 'REPLY' notification to parent comment author, using createNotification helper
        if (parentComment && parentComment.userId !== userId) { await createNotification('REPLY', { userId: parentComment.userId, senderId: userId, commentId: comment.id, postId }) }
      }

      return comment;                   // if transaction is successful, return the created comment
    });    

    res.status(201).json(result);       // respond with the created comment
  } catch (err) { next(err); }          // catch errors and pass to error handler
}



// -------------- Update comment Controller ----------------
export async function updateComment(req, res, next) {
  try {
    const { commentId } = req.params;         // get comment id from params
    const userId = req.user.id;               // get current user id, from req.user (token payload)
    const { content, taggedUsers = [] } = req.body;                   // extract fields from req.body
    const cleanContent = content ? sanitizeText(content) : content;   // sanitize received content
    
    // Find if comment exists, if not return 404 "Comment not found" 
    const comment = await prisma.comment.findUnique({ where: { id: commentId }, include: { post: true, tags: true } });
    if (!comment) { return res.status(404).json({ message: "Comment not found" }); }

    // Check permissions: only author or admin can update
    if (comment.userId !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: "Not authorized to update this comment" });
    }

    // Get existing tagged users ids for this comment
    const existingTaggedIds = comment.tags.map(t => t.taggedId);

    // Create prisma transaction for multiple db operations (all or nothing)
    const result = await prisma.$transaction(async (tx) => {
      // 1. Save old content in edit history model, if content changed 
      if (cleanContent && cleanContent !== comment.content) { await tx.editHistory.create({ data: { commentId, editorId: userId, oldContent: comment.content, newContent: cleanContent } }); }

      // 2. Handle tagged users updates if taggedUsers array provided
      if (taggedUsers !== undefined) {
        // Ensure taggedUsers is an array (e.g., from FormData)
        let taggedUsersArray = taggedUsers;
        if (typeof taggedUsers === 'string') { taggedUsersArray = [taggedUsers] }
        // Remove duplicates and self-tagging
        const uniqueTaggedUsers = [...new Set(taggedUsersArray)].filter(id => id !== userId);
        // Determine which tags to add and which to remove
        const toAdd = uniqueTaggedUsers.filter(id => !existingTaggedIds.includes(id));
        const toRemove = existingTaggedIds.filter(id => !uniqueTaggedUsers.includes(id));
        // Remove tags that are no longer present when taggedUsers is updated & changed
        if (toRemove.length) { await tx.tag.deleteMany({ where: { commentId, taggedId: { in: toRemove } } }) }
        // Add new tags
        for (const taggedId of toAdd) {
          const userExists = await tx.user.findUnique({ where: { id: taggedId }, select: { id: true } });
          if (userExists) {
            const tag = await tx.tag.create({ data: { postId: comment.postId, commentId: comment.id, taggedId, taggedById: userId } });
            await createNotification('TAG', { userId: taggedId, senderId: userId, postId: comment.postId, commentId: comment.id, tagId: tag.id });
          }
        }
      }

      // 3. Update comment in db, include user & tags needed info (related model) + count
      const updatedComment = await tx.comment.update({ 
        where: { id: commentId }, data: { content: cleanContent }, 
        include: { 
          user: { select: { id: true, name: true, image: true } },
          tags: { include: { tagged: { select: { id: true, name: true, image: true } } } },          
          _count: { select: { replies: true, reactions: true, editHistory: true } }          
        }
      });

      // isEdited field (needed for UI), we calculate it based on count of editHistory record
      updatedComment.isEdited = updatedComment._count?.editHistory > 0;
      return updatedComment;             // if transaction is successful, return the updated comment
    });

    res.json(result);                    // respond with the transaction result (updated comment)
  } catch (err) { next(err); }           // catch errors and pass to error handler
}



// ------------ Delete comment Controller ----------------
export async function deleteComment(req, res, next) {
  try {
    const { commentId } = req.params;           // get comment id from params      

    // Check if comment exists, if not return 404 "Comment not found"
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, userId: true, postId: true, parentId: true, post: { select: { authorId: true } }, },
     });
    if (!comment) { return res.status(404).json({ message: "Comment not found" }); }

    // Check permissions: only comment author or post author or admin can delete
    if (comment.userId !== req.user.id && comment.post.authorId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: "Not authorized to delete this comment" });
    }

    // Create prisma transaction to cascade delete related data (All or Nothing), using cascade delete helper
    await prisma.$transaction(async (tx) => {
      // Compute the subtree once so counters are accurate
      const subtree = await collectCommentDescendants(tx, [commentId]);

      // Decrement post.commentCount by the total number of comments being removed
      await tx.post.update({ where: { id: comment.postId }, data: { commentCount: { decrement: subtree.length } }, });

      // If the root comment is a reply, decrement its parent's replyCount
      if (comment.parentId) {
        await tx.comment.update({ where: { id: comment.parentId }, data: { replyCount: { decrement: 1 } }, });
      }

      // Hand off to the shared cascade helper
      await deleteCommentsCascade(tx, [commentId]);
    });

    res.json({ message: "Comment deleted successfully", postId: comment.postId });   // respond with success message
  } catch (err) { next(err); }                                                       // catch errors and pass to error handler
}
