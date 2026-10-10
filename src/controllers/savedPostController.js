import { prisma } from "../prisma.js";
import { canUserViewPost, getFriendIdsCached, getBlockedUserIdsCached } from '../utils/privacy.js';


// ---------------- SAVE POST (BOOKMARK) CONTROLLER ----------------
export async function savePost(req, res, next) {
  try {
    const userId = req.user.id;              // get user id from req.user (auth middleware token)
    const postId = req.params.postId;        // get post id from params

    // Check if already saved, if so return 400 "Post already saved"
    const exists = await prisma.savedPost.findUnique({ where: { userId_postId: { userId, postId } } });
    if (exists) { return res.status(400).json({ message: "Post already saved" }); }

    const saved = await prisma.savedPost.create({ data: { userId, postId } });  // save post in db
    res.status(201).json(saved);          // respond with saved post
  } catch (err) { next(err); }            // catch errors and pass to error handler
}



// ---------------- REMOVE SAVED POST ----------------
export async function removeSavedPost(req, res, next) {
  try {
    const userId = req.user.id;              // get user id from req.user (auth middleware token)
    const postId = req.params.postId;        // get post id from params

    // Ensure exists, if not return 404 "Not saved"
    const exists = await prisma.savedPost.findUnique({ where: { userId_postId: { userId, postId } } });
    if (!exists) { return res.status(404).json({ message: "Not saved" }); }

    await prisma.savedPost.delete({ where: { userId_postId: { userId, postId } } });  // remove from db

    res.json({ message: "Removed from saved posts" });      // respond with success message
  } catch (err) { next(err); }                              // catch errors and pass to error handler
}



// ---------------- TOGGLE SAVE/UNSAVE ----------------
export async function toggleSavedPost(req, res, next) {
  try {
    const userId = req.user.id;                     // get user id from req.user (auth middleware token)
    const postId = req.params.postId;               // get post id from params

    // Check if already saved, if so unsave, return "Post unsaved"
    const exists = await prisma.savedPost.findUnique({ where: { userId_postId: { userId, postId } } });
    if (exists) { 
      await prisma.savedPost.delete({ where: { userId_postId: { userId, postId } } });
      return res.json({ saved: false, message: "Post unsaved" });
    }
   
    // save post in db, after we checked that it was not already saved
    await prisma.savedPost.create({ data: { userId, postId } });    

    res.json({ saved: true, message: "Post saved" });        // respond with success message
  } catch (err) { next(err); }                               // catch errors and pass to error handler
}



// ---------------- GET ALL MY SAVED POSTS ----------------
export async function getMySavedPosts(req, res, next) {
  try {
    const userId = req.user.id;                       // get user id from req.user (auth middleware token)
    const limit = parseInt(req.query.limit) || 10;    // get limit from URL query OR default to 10
    const cursor = req.query.cursor;                  // get cursor from URL query (for infinite scroll)

    // Get friendIds and blockedIds if user is logged in (to apply privacy filter on saved posts)
    const friendIds = req.user?.id ? await getFriendIdsCached(req.user.id) : [];
    const blockedIds = req.user?.id ? await getBlockedUserIdsCached(req.user.id) : [];

    const saved = await prisma.savedPost.findMany({
      take: limit + 1,                                  // +1 to check if there are more posts after the limit
      skip: cursor ? 1 : 0,                             // skip the extra post if there is a cursor
      cursor: cursor ? { id: cursor } : undefined,      // set the cursor indicator
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], // order 'desc' by createdAt + id (to ensure consistent order when createdAt is the same)
      where: { userId },                                // filter by user id & exclude deleted posts
      include: { 
          post: { 
            include: { 
              author: { select: { id: true, name: true, image: true } }, 
              tags: { include: { tagged: { select: { id: true, name: true, image: true } } } },
              originalPost: { include: { author: { select: { id: true, name: true, image: true } } } },
              reactions: req.user?.id ? { where: { userId: req.user.id }, select: { type: true } } : false,
              shares: req.user?.id ? { where: { userId: req.user.id }, select: { userId: true } } : false,
              _count: { select: { editHistory: true } },
            } 
          } 
        } 
      });

    // For each saved post, if it's a shared post (originalPost not null), check if the user can view the original post (based on original post privacy settings)  
    for (const item of saved) {
      if (item.post.originalPost) {
        const canView = canUserViewPost(item.post.originalPost, req.user?.id, friendIds, blockedIds);
        if (!canView) item.post.originalPost = null;
      }
    }  
        
    // if there are more posts than the limit, set next cursor
    let nextCursor = null;
    if (saved.length > limit) { nextCursor = saved[limit-1].id; saved.pop(); }

    // Transform output to a flat array of posts to include (savedAt) field needed in UI + (myReaction) field (needed for UI to show current user's post reaction without needing extra request) + (isEdited) field (checks editHistory count) + (hasShared) field (to show if current user shared this post)
    const SavedArray = saved.map(item => ({ ...item.post, isShared: !!item.post.originalPostId, savedAt: item.createdAt, myReaction: item.post.reactions?.[0]?.type ?? null, isEdited: item.post._count?.editHistory > 0, hasShared: !!item.post.shares?.length }));
    res.json({ nextCursor, posts: SavedArray });    // respond with saved posts and next cursor (infinite scroll pagination)
  } catch (err) { next(err); }                      // catch errors and pass to error handler
}
