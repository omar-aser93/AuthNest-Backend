import { prisma } from '../prisma.js';
import { canUserViewPost, getFriendIdsCached, getBlockedUserIdsCached } from '../utils/privacy.js';
import { createNotification } from '../utils/notificationHelper.js';


// ---------------- SHARE POST CONTROLLER ----------------
export async function sharePost(req, res, next) {
  try {
    const { postId } = req.params;                    // get post id from req params (/:postId)
    const { message, privacy, blocked } = req.body;   // extract message, privacy and blocked users from req.body
    const userId = req.user.id;                       // get current user id, from req.user (token payload) 

    // Sanitize blocked array — strips "__clear__" sentinel and invalid ObjectIDs
    const cleanIdArray = (arr) => {
      const inputArr = Array.isArray(arr) ? arr : [arr];
      return inputArr.filter(id => {
        if (!id || typeof id !== 'string' || id.trim() === "__clear__") return false;
        return /^[0-9a-fA-F]{24}$/.test(id.trim());
      });
    };
    const cleanBlocked = cleanIdArray(blocked);

    // Get the original post from the db, If not found return 404 "Post not found", if original post's author is the same as current user return 400 "You cannot share your own post"
    const original = await prisma.post.findUnique({ where: { id: postId } });
    if (!original) return res.status(404).json({ message: "Post not found" });
    if (original.authorId === req.user.id) return res.status(400).json({ error: "You cannot share your own post" });

    // Setting the privacy utility for the post:
    const friendIds = userId ? await getFriendIdsCached(userId) : [];        // get friends IDs (cached) for current user 
    const blockedIds = userId ? await getBlockedUserIdsCached(userId) : [];  // get blocked users IDs (cached) for current user
    // Check if user can view this post, if not return 403 'You cannot share this post'
    if (!canUserViewPost(original, userId, friendIds, blockedIds)) { return res.status(403).json({ message: "You cannot share this post" }); }

    // Check if already shared, if so return 400 "Post already shared"
    const existingShare = await prisma.share.findFirst({ where: { userId, postId } });
    if (existingShare) { return res.status(400).json({ message: "Post already shared" }); }

    // Create share record (for tracking shares) in db
    const share = await prisma.share.create({ data: { userId, postId, message } });

    // Create new Post (the shared post) in db with reference to original post, we set the 'share message' into the content field of the shared post, also set privacy to received value from req.body 
    const sharedPost = await prisma.post.create({
      data: { authorId: userId, originalPostId: original.id, content: message || null, privacy: privacy, allowed: [], blocked: cleanBlocked},           
      include: { author: { select: { id: true, name: true, image: true } }, originalPost: { include: { author: { select: { id: true, name: true, image: true } } } } }
    });

    // Increment post share count (We use this method instead of [$count or .length] for better performance for large datasets)
    await prisma.post.update({ where: { id: postId }, data: { shareCount: { increment: 1 } }});

    // Create notification if not sharing own post
    if (original.authorId !== userId) { await createNotification('SHARE', { userId: original.authorId, senderId: userId, postId, shareId: share.id }); }
    
    // Response with success message, share record and the shared post
    res.status(201).json({ message: "Post shared successfully", share, sharedPost });    
  } catch (err) { next(err); }            // catch errors and pass to error handler
}



// ---------------- GET POST SHARES INFO CONTROLLER ----------------
export async function getPostShares(req, res, next) {
  try {
    const { postId } = req.params;                         // get post id from req params (/:postId)    
    const limit = parseInt(req.query.limit) || 20;         // get limit from URL query OR default to 20
    const cursor = req.query.cursor;                       // get cursor from URL query (for infinite scroll)

    // Check if post exists, if not return 404 "Post not found"
    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) { return res.status(404).json({ message: "Post not found" }); }

    // Setting the privacy utility for the post:
    const friendIds = req.user?.id ? await getFriendIdsCached(req.user.id) : [];  // get friends IDs (cached) for current user 
    const blockedIds = req.user?.id ? await getBlockedUserIdsCached(req.user.id) : [];  // get blocked users IDs (cached) for current user
    // Check if user can view this post, if not return 403 'You cannot get shares on this post'
    if (!canUserViewPost(post, req.user?.id, friendIds, blockedIds)) { return res.status(403).json({ message: "You cannot get shares on this post" }); }
   
    // Get shares with pagination
    const shares = await prisma.share.findMany({
      take: limit + 1,                                  // +1 to check if there are more shares after the limit
      skip: cursor ? 1 : 0,                             // skip the extra share if there is a cursor
      cursor: cursor ? { id: cursor } : undefined,      // set the cursor indicator
      where: { postId },                                // filter by post id
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // order by creation date (descending) + id (to ensure consistent order when createdAt is the same)
      include: { user: { select: { id: true, name: true, image: true } } }
    });

    // if there are more shares than the limit, set next cursor
    let nextCursor = null;
    if (shares.length > limit) { nextCursor = shares[limit-1].id; shares.pop(); }

    res.json({ shares, nextCursor });             // response with shares and next cursor
  } catch (err) { next(err); }                    // catch errors and pass to error handler
}



// ---------------- UNSHARE POST CONTROLLER ----------------
export async function unsharePost(req, res, next) {
  try {
    const { postId } = req.params;                 // get post id from params
    const userId = req.user.id;                    // get current user id, from req.user (token payload)

    // Find the share, if not found return 404 "Share not found"
    const share = await prisma.share.findFirst({ where: { userId, postId } });
    if (!share) { return res.status(404).json({ message: "Share not found" }); }

    // Find the generated shared post by author id and original post id
    const sharedPost = await prisma.post.findFirst({ where: { authorId: userId, originalPostId: postId } });

    // Delete the shared post (if exists)
    if (sharedPost) { await prisma.post.delete({ where: { id: sharedPost.id } }); }
    // Delete share info record from db
    await prisma.share.delete({ where: { id: share.id } });

    // Decrement post share count (We use this method instead of [$count or .length] for better performance for large datasets)
    await prisma.post.update({ where: { id: postId }, data: { shareCount: { decrement: 1 } } });

    res.json({ message: "Post unshared successfully" });    // response with success message
  } catch (err) { next(err); }                              // catch errors and pass to error handler
}