import { prisma } from '../prisma.js';
import { uploadToCloudinary } from "../utils/uploadToCloudinary.js";
import { buildPrivacyFilter, canUserViewPost, getFriendIdsCached, getBlockedUserIdsCached } from '../utils/privacy.js';
import { createNotification } from '../utils/notificationHelper.js';
import { deletePostsCascade } from "../utils/cascadeDelete.js";
import { sanitizeText } from '../utils/XSS-sanitization.js';


// ---------------- CREATE POST CONTROLLER ----------------
export async function createPost(req, res, next) {
  try {    
    // Get title, content, privacy, allowed, blocked, taggedUsers from req.body   
    const { title, content, privacy, allowed = [], blocked = [], taggedUsers = [] } = req.body;
    const cleanContent = content ? sanitizeText(content) : content;  // sanitize received content 
    const userId = req.user?.id;             // get current user id, from req.user (token payload)
    
    // Sanitize allowed/blocked arrays — strips "__clear__" sentinel and invalid ObjectIDs (important fix)
    const cleanIdArray = (arr) => {
      const inputArr = Array.isArray(arr) ? arr : [arr];
      return inputArr.filter(id => {
        if (!id || typeof id !== 'string' || id.trim() === "__clear__") return false;
        return /^[0-9a-fA-F]{24}$/.test(id.trim());
      });
    };
    const cleanAllowed = cleanIdArray(allowed);   // Cleaned arrays will be empty if no valid IDs, which indicates clearing the field in DB
    const cleanBlocked = cleanIdArray(blocked);   // Cleaned arrays will be empty if no valid IDs, which indicates clearing the field in DB

    // Handle image upload (req.file)
    let imageUrl = null;
    if (req.file) {
      const uploaded = await uploadToCloudinary(req.file.path, "posts");
      imageUrl = uploaded.url;      
    }
   
    // extract Hashtags from the post content
    const hashtags = (cleanContent?.match(/#\w+/g) || []).map(t => t.replace("#", "").toLowerCase());

    // Create prisma transaction for multiple operations (All or Nothing)
    const result = await prisma.$transaction(async (tx) => {
      // 1. create post in db, using data from req.body + image url + extracted hashtags + current (logged in) user id
      const post = await tx.post.create({ data: { title, content: cleanContent, privacy, allowed: cleanAllowed, blocked: cleanBlocked, image: imageUrl, hashtags, authorId: userId } });
      
      // 2. handle tagged users for the post, if tagged users array provided      
      const uniqueTaggedUsers = [...new Set(taggedUsers)].filter(id => id !== userId);  // Remove duplicates & self-tagging
      // for each tagged user, check if user exists in db
      for (const taggedId of uniqueTaggedUsers) {
        const userExists = await tx.user.findUnique({ where: { id: taggedId }, select: { id: true } });
        // if user exists, create tag record for the post, then send TAG notification using createNotification helper
        if (userExists) {
          const tag = await tx.tag.create({ data: { postId: post.id, taggedId, taggedById: userId } });          
          await createNotification('TAG', { userId: taggedId, senderId: userId, postId: post.id, tagId: tag.id });
        }
      }
      
      //if transaction succeeded, Return the created post, include author info & tags (a DB related models)
      return await tx.post.findUnique({
        where: { id: post.id },
        include: { author: { select: { id: true, name: true, image: true } }, tags: { include: { tagged: { select: { id: true, name: true, image: true } }} }}
      });
    });

    res.status(201).json(result);       // respond with the created post
  } catch (err) { next(err); }          // catch errors and pass to error handler
}



// ---------------- GET ALL POSTS CONTROLLER ----------------
export async function getAllPosts(req, res, next) {
  try {
    const limit = parseInt(req.query.limit) || 10;         // get limit from URL query OR default to 10
    const cursor = req.query.cursor;                       // get cursor from URL query (for infinite scroll)
    const q = req.query.search?.trim();                    // get search query from URL query and trim whitespace
   
    // if search q less than 2 characters, return empty result (to avoid unnecessary DB load and meaningless search)
    if (q && q.length < 2) { return res.json({ posts: [], nextCursor: null })} 

    // Set the privacy filter Utility (to hide posts based on post privacy settings): 
    const friendIds = req.user?.id ? await getFriendIdsCached(req.user.id) : [];        // get friends IDs (cached) for current user 
    const blockedIds = req.user?.id ? await getBlockedUserIdsCached(req.user.id) : [];  // get blocked users IDs (cached) for current user
    const privacyFilter = buildPrivacyFilter(req.user?.id, friendIds, blockedIds);      // Build privacy filter

    // Build where clause, default to privacy filter, if search query provided -> (search in title and content, case insensitive)
    let where = privacyFilter;
    if (q) {
      where = {
        AND: [ privacyFilter, { OR: [{ title: { contains: q, mode: "insensitive" } }, { content: { contains: q, mode: "insensitive" } } ]} ]
      };
    }
    
    // fetch all posts from db (include author needed info -> a DB related model) + set pagination & order
    const posts = await prisma.post.findMany({ 
      take: limit + 1,                               // +1 to check if there are more posts after the limit
      skip: cursor ? 1 : 0,                          // skip the extra post if there is a cursor
      cursor: cursor ? { id: cursor } : undefined,   // set the cursor indicator
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], // order 'desc' by createdAt + id (to ensure consistency when multiple posts have same createdAt)
      where,                                            // apply where clause (includes privacy filter and search)
      include: { 
        author: { select: { id: true, name: true, image: true } }, 
        tags: { include: { tagged: { select: { id: true, name: true, image: true } }} },
        reactions: req.user?.id ? { where: { userId: req.user?.id }, select: { type: true } } : false ,
        shares: req.user?.id ? { where: { userId: req.user?.id }, select: { userId: true } } : false,
        originalPost: { include: { author: { select: { id: true, name: true, image: true } } } },
        _count: { select: { editHistory: true } },
      } 
    });

    // For each post, if it's a shared post (originalPost not null), check if the user can view the original post (based on original post privacy settings)
    for (const post of posts) {
      if (post.originalPost) {
        const canView = canUserViewPost(post.originalPost, req.user?.id, friendIds, blockedIds);
        if (!canView) post.originalPost = null;
      }
    }
  
    // if there are more posts than the limit, set next cursor 
    let nextCursor = null;
    if (posts.length > limit) { nextCursor = posts[limit-1].id; posts.pop(); }

    // Transform output to array of posts to include myReaction field (needed for UI to show current user's post reaction without needing extra request) + isEdited field (checks editHistory count) + hasShared field (to show if current user has shared this post)
    const formattedPosts = posts.map((post) => ({ ...post, isShared: !!post.originalPostId, myReaction: post.reactions?.[0]?.type ?? null, isEdited: post._count?.editHistory > 0, hasShared: !!post.shares?.length }));
    res.json({ nextCursor, posts: formattedPosts });    // respond with posts and next cursor (infinite scroll pagination)
  } catch (err) { next(err); }                          // catch errors and pass to error handler
}



//---------------- GET MY POSTS CONTROLLER ----------------
// Note: I created it to work with both (infinite scroll & Numbered pagination), as example if we wanted to use one or both with any other controller
export async function getMyPosts(req, res, next) {
  try {
    const limit = parseInt(req.query.limit) || 10;   // get limit from URL query OR default to 10
    const cursor = req.query.cursor;                 // get cursor from URL query (for infinite scroll)
    const pageRaw = req.query.page;                  // get page from URL query (for numbered pagination)
    const page = pageRaw ? parseInt(pageRaw) : undefined;   // undefined if no page parameter

    // // Set the privacy filter Utility (to hide posts based on post privacy settings) Cached friend/block IDs
    const friendIds = req.user?.id ? await getFriendIdsCached(req.user.id) : [];
    const blockedIds = req.user?.id ? await getBlockedUserIdsCached(req.user.id) : [];

    // variables to hold the response data
    let posts, nextCursor, totalPages, currentPage, totalCount;

    // ----- 1. OFFSET PAGINATION (numbered pages) – only when `page` is explicitly provided -----
    if (page !== undefined) {
      totalCount = await prisma.post.count({ where: { authorId: req.user?.id } });
      posts = await prisma.post.findMany({
        take: limit,                              // limit the number of posts based on received limit
        skip: (page - 1) * limit,                 // skip posts based on page number
        orderBy: { createdAt: "desc" },           // order 'desc' by createdAt
        where: { authorId: req.user?.id },        // filter by logged-in user id
        include: {
          author: { select: { id: true, name: true, image: true } },
          tags: { include: { tagged: { select: { id: true, name: true, image: true } } } },
          reactions: req.user?.id ? { where: { userId: req.user?.id }, select: { type: true } } : false,
          shares: req.user?.id ? { where: { userId: req.user?.id }, select: { userId: true } } : false,
          originalPost: { include: { author: { select: { id: true, name: true, image: true } } } },
          _count: { select: { editHistory: true } },
        },
      });

      // For each shared post, check if the current user can view the original post
      for (const post of posts) {
        if (post.originalPost) {
          const canView = canUserViewPost(post.originalPost, req.user?.id, friendIds, blockedIds);
          if (!canView) post.originalPost = null;
        }
      }

      totalPages = Math.ceil(totalCount / limit);      // calculate total pages
      currentPage = page;                              // set current page
      nextCursor = null;   // offset pagination does not use cursor
    } 
    // ----- 2. CURSOR-BASED PAGINATION (infinite scroll) – used when no `page` is provided -----
    else {
      posts = await prisma.post.findMany({
        take: limit + 1,                               // fetch one extra to determine if more exist
        skip: cursor ? 1 : 0,                          // skip the cursor record when paginating
        cursor: cursor ? { id: cursor } : undefined,   // set the cursor
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],  // order 'desc' by createdAt + id (to ensure consistency when multiple posts have same createdAt)
        where: { authorId: req.user?.id },                 // filter by logged-in user id
        include: {
          author: { select: { id: true, name: true, image: true } },
          tags: { include: { tagged: { select: { id: true, name: true, image: true } } } },
          reactions: req.user?.id ? { where: { userId: req.user?.id }, select: { type: true } } : false,
          shares: req.user?.id ? { where: { userId: req.user?.id }, select: { userId: true } } : false,
          originalPost: { include: { author: { select: { id: true, name: true, image: true } } } },
          _count: { select: { editHistory: true } },
        },
      });

      // For each shared post, check visibility of the original post
      for (const post of posts) {
        if (post.originalPost) {
          const canView = canUserViewPost(post.originalPost, req.user?.id, friendIds, blockedIds);
          if (!canView) post.originalPost = null;
        }
      }

      // Determine next cursor (null if no more posts)
      nextCursor = null;
      if (posts.length > limit) {
        nextCursor = posts[limit - 1].id;    // last item of the current page
        posts.pop();                         // remove the extra fetched item
      }
    }

    // Transform posts to include additional needed UI fields (myReaction, isEdited, hasShared, isShared) without needing extra processing on the client side
    const formattedPosts = posts.map((post) => ({ ...post, isShared: !!post.originalPostId, myReaction: post.reactions?.[0]?.type ?? null, isEdited: post._count?.editHistory > 0, hasShared: !!post.shares?.length }));
    // respond with posts & pagination info (nextCursor for infinite scroll, totalPages & currentPage for numbered pagination
    res.json({ nextCursor,  posts: formattedPosts, totalPages, currentPage, totalCount });
  } catch (err) { next(err); }       // catch errors and pass to the error handler
}



// ---------------- GET A SINGLE POST CONTROLLER ----------------
export async function getPostById(req, res, next) {
  try {
    // fetch post from db by id (include author needed info -> a DB related model)
    const post = await prisma.post.findUnique({ where: { id: req.params.id }, include: { 
      author: { select: { id: true, name: true, image: true } }, 
      tags: { include: { tagged: { select: { id: true, name: true, image: true } } } },
      reactions: req.user?.id ? { where: { userId: req.user?.id }, select: { type: true } } : false,
      shares: req.user?.id ? { where: { userId: req.user?.id }, select: { userId: true } } : false,
      originalPost: { include: { author: { select: { id: true, name: true, image: true } } } },
      _count: { select: { editHistory: true } },
    } });

    if (!post) return res.status(404).json({ message: 'Not found' });     // if not found return 404
   
    // Setting the privacy utility for the post:
    const friendIds = req.user?.id ? await getFriendIdsCached(req.user?.id) : [];  // get friends IDs (cached) for current user 
    const blockedIds = req.user?.id ? await getBlockedUserIdsCached(req.user?.id) : [];  // get blocked users IDs (cached) for current user 
    // Check if user can view this post, if not return 403 'You're not allowed to view this post'
    if (!canUserViewPost(post, req.user?.id, friendIds, blockedIds)) { return res.status(403).json({ message: "You're not allowed to view this post" }); }

    // For the post, if it's a shared post (originalPost not null), check if the user can view the original post (based on original post privacy settings)
    if (post.originalPost) {
      const canView = canUserViewPost(post.originalPost, req.user?.id, friendIds, blockedIds);
      if (!canView) post.originalPost = null;
    }

    // Transform output to include myReaction field (needed for UI to show current user's post reaction) + isEdited field (checks editHistory count) + hasShared field (to show if current user has shared this post)
    post.myReaction = post.reactions?.[0]?.type ?? null;
    post.isEdited = post._count?.editHistory > 0;
    post.hasShared = post.shares?.length ? true : false;
    post.isShared = !!post.originalPostId;
  
    res.json(post);                    // respond with post
  } catch (err) { next(err); }         // catch errors and pass to error handler
}



// ---------------- UPDATE POST CONTROLLER ----------------
export async function updatePost(req, res, next) {
  try {    
    const postId = req.params.id;           // get post id from params
    const userId = req.user.id;             // get current user id, from req.user (token payload)    
    const { title, content, privacy, allowed, blocked, taggedUsers = [] } = req.body;  // extract fields from req.body
    const cleanContent = content ? sanitizeText(content) : content;     // sanitize received content

    // find existing post, if not found return 404 "Post not found"
    const existing = await prisma.post.findUnique({ where: { id: postId }, include:{ tags: true } });
    if (!existing) return res.status(404).json({ message: "Post Not found" });

    // check permissions: allow only author or admin
    if (existing.authorId !== userId && req.user.role !== "admin") {
      return res.status(403).json({ message: "Forbidden" });
    }

    // prepare data object for updating based on req.body
    const data = {};
    if (title) data.title = title;
    if (content) data.content = cleanContent;   
    if (privacy) data.privacy = privacy;

    // sanitize allowed/blocked arrays — strips "__clear__" sentinel and invalid ObjectIDs (important fix), also handle the case if allowed/blocked is sent as a single string (from FormData)
    const cleanIdArray = (arr) => {
      if (!arr) return undefined;
      const inputArr = Array.isArray(arr) ? arr : [arr];
      // Filter out the "__clear__" sentinel and invalid IDs
      const valid = inputArr.filter(id => {
        if (!id || typeof id !== 'string' || id.trim() === "__clear__") return false;
        return /^[0-9a-fA-F]{24}$/.test(id.trim());
      });
      // Return empty array (clears DB field) even if no valid IDs remain
      return valid;
    };
    if (allowed !== undefined) data.allowed = cleanIdArray(allowed);
    if (blocked !== undefined) data.blocked = cleanIdArray(blocked);

    // Handle image upload (req.file)
    if (req.file) {
      const uploaded = await uploadToCloudinary(req.file.path, "posts");
      data.image = uploaded.url;     
    }
    // Re-extract hashtags if content changed
    if (content) {
      const hashtags = (cleanContent?.match(/#\w+/g) || []).map(t => t.replace("#", "").toLowerCase());
      data.hashtags = hashtags;      
    }

    // Get existing tagged users ids for this post
    const existingTaggedIds = existing.tags.map(t => t.taggedId);

    // Create prisma transaction for multiple operations (All or Nothing)
    const result = await prisma.$transaction(async (tx) => {
      // 1. Save old content in edit history model, if content changed
      if (cleanContent && cleanContent !== existing.content) {         
        await tx.editHistory.create({ data: { postId, editorId: userId, oldContent: existing.content || "...", newContent: cleanContent } });
      }

      // 2. update post in db by id, using data object, include author needed info -> a DB related model
      const updatedPost = await tx.post.update({ where: { id: postId }, data, include: { author: { select: { id: true, name: true, image: true }}, tags: { include: { tagged: { select: { id: true, name: true, image: true } }} } } });

      // 3. Handle tagged users updates if taggedUsers array provided
      if (taggedUsers !== undefined) {
        // Ensure taggedUsers is an array (e.g., from FormData)
        let taggedUsersArray = taggedUsers;
        if (typeof taggedUsers === 'string') { taggedUsersArray = [taggedUsers] }
        // Remove duplicates and exclude current user
        const uniqueTaggedUsers = [...new Set(taggedUsersArray)].filter(id => id !== userId);
        // Determine which tags to add and which to remove
        const toAdd = uniqueTaggedUsers.filter(id => !existingTaggedIds.includes(id));
        const toRemove = existingTaggedIds.filter(id => !uniqueTaggedUsers.includes(id));
        // Remove tags that are no longer present when taggedUsers updated & changed
        if (toRemove.length) { await tx.tag.deleteMany({ where: { postId, taggedId: { in: toRemove }, commentId: null } })}
        // Add new tags
        for (const taggedId of toAdd) {
          const userExists = await tx.user.findUnique({ where: { id: taggedId }, select: { id: true } });
          if (userExists) {
            const tag = await tx.tag.create({ data: { postId, taggedId, taggedById: userId } });
            await createNotification('TAG', { userId: taggedId, senderId: userId, postId, tagId: tag.id });
          }
        }
      }   

      return updatedPost;          // if transaction succeed, return updated post
    });
    
    res.json(result);              // respond with the updated post
  } catch (err) { next(err); }     // catch errors and pass to error handler
}



// ---------------- DELETE POST CONTROLLER ----------------
export async function deletePost(req, res, next) {
  try {
    // find existing post, if not found return 404 "not found"
    const existing = await prisma.post.findUnique({ where: { id: req.params.id }, select: { id: true, authorId: true } });
    if (!existing) return res.status(404).json({ message: 'Post not found' });
    
    // check permissions: allow only author or admin, if not return 403 "forbidden"
    if (existing.authorId !== req.user?.id && req.user?.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });

    // use the cascade delete helper, to delete all related data (comments with replies, reactions, shares, saved, tags, editHistory, notifications).
    await prisma.$transaction(async (tx) => {
      await deletePostsCascade(tx, [existing.id]);
    });

    res.json({ message: 'Post deleted successfully' });    // respond with success message
  } catch (err) { next(err); }                             // catch errors and pass to error handler
}



// ---------------- LIST POSTS BY USER CONTROLLER ----------------
export async function listPostsByUser(req, res, next) {
  try {    
    const limit = parseInt(req.query.limit) || 10;         // get limit from URL query OR default to 10
    const cursor = req.query.cursor;                       // get cursor from URL query

    // Set the privacy filter Utility (to hide posts based on post privacy settings): 
    const friendIds = req.user?.id ? await getFriendIdsCached(req.user.id) : [];        // get friends IDs (cached) for current user 
    const blockedIds = req.user?.id ? await getBlockedUserIdsCached(req.user.id) : [];  // get blocked users IDs (cached) for current user 
    const privacyFilter = buildPrivacyFilter(req.user?.id, friendIds, blockedIds);      // Build privacy filter

    // fetch posts from db by user id (include author needed info -> a DB related model) + set pagination & order    
    const posts = await prisma.post.findMany({
      take: limit + 1,                                // +1 to check if there are more posts after the limit
      skip: cursor ? 1 : 0,                           // skip the extra post if there is a cursor
      cursor: cursor ? { id: cursor } : undefined,    // set the cursor indicator
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], // order 'desc' by createdAt + id (to ensure consistency when multiple posts have same createdAt)
      where: { AND: [ { authorId: req.params.userId }, privacyFilter ] },     // filter by user id & privacy filter 
      include: { 
        author: { select: { id: true, name: true, image: true } }, 
        tags: { include: { tagged: { select: { id: true, name: true, image: true } }} },
        reactions: req.user?.id ? { where: { userId: req.user?.id }, select: { type: true } } : false,
        shares: req.user?.id ? { where: { userId: req.user?.id }, select: { userId: true } } : false,
        originalPost: { include: { author: { select: { id: true, name: true, image: true } } } },
        _count: { select: { editHistory: true } },
      } 
    });

    // For each post, if it's a shared post (originalPost not null), check if the user can view the original post (based on original post privacy settings)
    for (const post of posts) {
      if (post.originalPost) {
        const canView = canUserViewPost(post.originalPost, req.user?.id, friendIds, blockedIds);
        if (!canView) post.originalPost = null;
      }
    }

    // if there are more posts than the limit, set next cursor 
    let nextCursor = null;
    if (posts.length > limit) { nextCursor = posts[limit-1].id; posts.pop(); }

    // Transform output to array of posts to include myReaction field (needed for UI to show current user's post reaction without needing extra request) + isEdited field (checks editHistory count) + hasShared field (to show if current user has shared this post)
    const formattedPosts = posts.map((post) => ({ ...post, isShared: !!post.originalPostId, myReaction: post.reactions?.[0]?.type ?? null, isEdited: post._count?.editHistory > 0, hasShared: !!post.shares?.length }));
    res.json({ nextCursor, posts: formattedPosts });   // respond with posts and next cursor (infinite scroll pagination)
  } catch (err) { next(err); }                         // catch errors and pass to error handler
}



// ---------------- GET POSTS BY HASHTAG CONTROLLER ----------------
export async function getPostsByHashtag(req, res, next) {
  try {
    const tag = req.params.tag.toLowerCase();        // get tag from params
    const limit = parseInt(req.query.limit) || 10;   // get limit from URL query OR default to 10
    const cursor = req.query.cursor;                 // get cursor from URL query
    
    // Set the privacy filter Utility (to hide posts based on post privacy settings): 
    const friendIds = req.user?.id ? await getFriendIdsCached(req.user.id) : [];        // get friends IDs (cached) for current user 
    const blockedIds = req.user?.id ? await getBlockedUserIdsCached(req.user.id) : [];  // get blocked users IDs (cached) for current user 
    const privacyFilter = buildPrivacyFilter(req.user?.id, friendIds, blockedIds);      // Build privacy filter

    // fetch posts from db by hashtag (include author needed info -> a DB related model) + set pagination & order
    const posts = await prisma.post.findMany({
      take: limit + 1,                                // +1 to check if there are more posts after the limit
      skip: cursor ? 1 : 0,                           // skip the extra post if there is a cursor
      cursor: cursor ? { id: cursor } : undefined,    // set the cursor indicator
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], // order 'desc' by createdAt + id (to ensure consistency when multiple posts have same createdAt)
      where: { AND: [{ hashtags: { has: tag } }, privacyFilter ] },             // apply privacy filter
      include: { 
        author: { select: { id: true, name: true, image: true } }, 
        tags: { include: { tagged: { select: { id: true, name: true, image: true } }} },
        reactions: req.user?.id ? { where: { userId: req.user?.id }, select: { type: true } } : false,
        shares: req.user?.id ? { where: { userId: req.user?.id }, select: { userId: true } } : false,
        originalPost: { include: { author: { select: { id: true, name: true, image: true } } } },
        _count: { select: { editHistory: true } },
      } 
    });

    // For each post, if it's a shared post (originalPost not null), check if the user can view the original post (based on original post privacy settings)
    for (const post of posts) {
      if (post.originalPost) {
        const canView = canUserViewPost(post.originalPost, req.user?.id, friendIds, blockedIds);
        if (!canView) post.originalPost = null;
      }
    }
 
    // if there are more posts than the limit, set next cursor 
    let nextCursor = null;
    if (posts.length > limit) { nextCursor = posts[limit-1].id; posts.pop(); }

    // Transform output to array of posts to include myReaction field (needed for UI to show current user's post reaction without needing extra request) + isEdited field (checks editHistory count) + hasShared field (to show if current user has shared this post)
    const formattedPosts = posts.map((post) => ({ ...post, isShared: !!post.originalPostId, myReaction: post.reactions?.[0]?.type ?? null, isEdited: post._count?.editHistory > 0, hasShared: !!post.shares?.length }));
    res.json({ nextCursor, posts: formattedPosts, tag });   // respond with posts, hashtag and next cursor (infinite scroll pagination)
  } catch (err) { next(err); }                              // catch errors and pass to error handler
}



// ---------------- GET TRENDING HASHTAGS CONTROLLER ----------------
export async function getTrendingHashtags(req, res, next) {
  try {
    const limit = parseInt(req.query.limit) || 20;      // get limit from URL query
    const userId = req.user?.id;                        // get current user id, from req.user (token payload)
    
    // Array For blocked friends, intialize it with current blocked users if logged in   
    let blockedIds = [];
    if (userId) { blockedIds = await getBlockedUserIdsCached(userId) }

    // For trending hashtags, we should only count PUBLIC posts OR posts visible to the current user (privacy filter)
    let matchFilter = { privacy: 'PUBLIC' };    
    if (userId) {     
      const friendIds = await getFriendIdsCached(userId);    // If user is logged in, get friend IDs for personalized trending
      // Count PUBLIC posts + posts visible to current user (allowed) + (not blocked)
      matchFilter = {
        AND: [
          { authorId: { notIn: blockedIds } },   // exclude blocked authors
          {  
          OR: [
            { privacy: 'PUBLIC' },
            { AND: [ { privacy: 'FRIENDS' }, { authorId: { in: friendIds } } ] },
            { AND: [ { privacy: 'CUSTOM' }, { allowed: { has: userId } }, { NOT: { blocked: { has: userId } } } ] }
          ]
        }]
      };
    }

    // fetch hashtags from db using aggregation, sort by count, limit by limit value, and return only hashtag and count
    const result = await prisma.$runCommandRaw({
      aggregate: "Post",
      pipeline: [
        { $match: matchFilter },
        { $unwind: "$hashtags" },
        { $group: { _id: "$hashtags", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limit },
        { $project: { hashtag: "$_id", count: 1, _id: 0 } }
      ],
      cursor: {}
    });
   
    res.json(result.cursor.firstBatch);         // respond with the trending hashtags 
  } catch (err) { next(err); }                  // catch errors and pass to error handler
}



// ---------------- SEARCH HASHTAGS CONTROLLER ----------------
// hashtags that start with the query, ordered by usage count (popularity). Uses MongoDB aggregation with pagination via $skip/$limit
export async function searchHashtags(req, res, next) {
  try {
    const q = req.query.q?.trim().toLowerCase();     // get search query from req.query
    const limit = parseInt(req.query.limit) || 20;   // get limit from req.query
    const page = parseInt(req.query.page) || 1;      // simple offset pagination
    const skip = (page - 1) * limit;                 // calculate offset for pagination

    if (!q) return res.json({ hashtags: [], totalPages: 0, currentPage: 1 });   // if no query, return empty array

    // Privacy filter: only count hashtags from visible posts (same as trending)
    const userId = req.user?.id;
    let matchFilter = { privacy: 'PUBLIC' };
    if (userId) {
      const friendIds = await getFriendIdsCached(userId);
      const blockedIds = await getBlockedUserIdsCached(userId);
      matchFilter = {
        AND: [
          { authorId: { notIn: blockedIds } },
          { OR: [
              { privacy: 'PUBLIC' },
              { AND: [ { privacy: 'FRIENDS' }, { authorId: { in: friendIds } } ] },
              { AND: [ { privacy: 'CUSTOM' }, { allowed: { has: userId } }, { NOT: { blocked: { has: userId } } } ] }
            ] }
        ]
      };
    }

    // fetch hashtags from db using aggregation, sort by count, limit by limit value, and return only hashtag and count
    const pipeline = [
      { $match: matchFilter },
      { $unwind: "$hashtags" },
      { $match: { hashtags: { $regex: `^${q}`, $options: "i" } } },
      { $group: { _id: "$hashtags", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $skip: skip },
      { $limit: limit },
      { $project: { hashtag: "$_id", count: 1, _id: 0 } }
    ];

    // Run the aggregation to get the paginated results
    const result = await prisma.$runCommandRaw({ aggregate: "Post", pipeline, cursor: {} });
    const hashtags = result.cursor.firstBatch;        // get the first batch of results
    // For total count, we need to run a separate aggregation without $skip and $limit, but with the same match conditions
    const totalCountPipeline = [
      { $match: matchFilter },
      { $unwind: "$hashtags" },
      { $match: { hashtags: { $regex: `^${q}`, $options: "i" } } },
      { $group: { _id: "$hashtags" } },
      { $count: "total" }
    ];
    // Run the total count aggregation
    const totalResult = await prisma.$runCommandRaw({
      aggregate: "Post",
      pipeline: totalCountPipeline,
      cursor: {}
    });
    const totalCount = totalResult.cursor.firstBatch[0]?.total || 0;    // if no total count, default to 0
    const totalPages = Math.ceil(totalCount / limit);                   // calculate total pages

    res.json({ hashtags, totalPages, currentPage: page });       // respond with the search results
  } catch (err) { next(err); }                                   // catch errors and pass to error handler
}