import { prisma } from '../prisma.js';
import { createNotification } from '../utils/notificationHelper.js';
import { invalidateFriendCache, invalidateBlockedCache, getBlockedUserIdsCached } from '../utils/privacy.js';


// ---------------- SEND FRIEND REQUEST CONTROLLER ----------------
export async function sendFriendRequest(req, res, next) {
  try {
    const { userId: receiverId } = req.params;       // Get User to send request to (from URL params) "/:userId"   
    const requesterId = req.user.id;                 // Get User who is sending the request (current token user)

    // check if sender and receiver are the same, if so return 400 'can't send to self'
    if (receiverId === requesterId) { return res.status(400).json({ message: "Cannot send friend request to yourself" }); }

    // Check if receiver user exists, if not return 404 'User not found'
    const receiver = await prisma.user.findUnique({ where: { id: receiverId } });
    if (!receiver) { return res.status(404).json({ message: "User not found" }); }

    // Check if request already exists in any direction
    const existingFriendship = await prisma.friendship.findFirst({ where: { OR: [ { requesterId, receiverId }, { requesterId: receiverId, receiverId: requesterId } ] }});

    // If request already exists, return with a message based on the status
    if (existingFriendship) {
      const status = existingFriendship.status;         // Get existing friendship status
      let message = "Friend request already exists";    // variable to hold a message
      
      // if status is ACCEPTED, message is "You are already friends"
      if (status === 'ACCEPTED') {
        message = "You are already friends";
      } else if (status === 'PENDING') {
        // if status is PENDING, check which user (sender/receiver) sent the request, then return a different message
        if (existingFriendship.requesterId === requesterId) {
          message = "Friend request already sent";
        } else {
          message = "You have a pending request from this user";
        }
      } else if (status === 'BLOCKED') {
        message = "This friendship is blocked";       // if status is BLOCKED, message is "This friendship is blocked"
      }

      return res.status(400).json({ message, status });     // Return with the message and the status
    }

    // Create friend request in both directions in the db
    const friendship = await prisma.friendship.create({
      data: { requesterId, receiverId, status: 'PENDING' },
      include: { requester: { select: { id: true, name: true, image: true } }, receiver: { select: { id: true, name: true, image: true } } }
    });

    // Create FRIEND_REQUEST notification, using the notification helper function
    await createNotification('FRIEND_REQUEST', { userId: receiverId, senderId: requesterId, requestId: friendship.id });

    // invalidate friend caches for both users (to be safe, even though they won't be friends yet, but it will clear any cached friend lists or statuses)
    invalidateFriendCache(requesterId);
    invalidateFriendCache(receiverId);

    res.status(201).json({ message: "Friend request sent", friendship });   // response with success message
  } catch (err) { next(err); }         // catch errors and pass to error handler
}



// ---------------- ACCEPT FRIEND REQUEST CONTROLLER ----------------
export async function acceptFriendRequest(req, res, next) {
  try {
    const { requestId } = req.params;                 // Get friend request id from URL params "/:requestId"
    const userId = req.user.id;                       // Get current user id, from req.user (token payload)

    // Find and update friendship from 'PENDING' to 'ACCEPTED'
    const friendship = await prisma.friendship.update({
      where: { id: requestId, receiverId: userId, status: 'PENDING' },
      data: { status: 'ACCEPTED' },
      include: { requester: { select: { id: true, name: true, image: true } }, receiver: { select: { id: true, name: true, image: true } } }
    });

    // If friendship is not found, return with a message
    if (!friendship) { return res.status(404).json({ message: "Friend request not found or already processed" }); }

    // Create FRIEND_REQUEST_ACCEPT notification for requester, using the notification helper function
    await createNotification('FRIEND_REQUEST_ACCEPT', { userId: friendship.requesterId,  senderId: userId, requestId: friendship.id });

    // After successful accept, invalidate friend caches for both users
    invalidateFriendCache(userId);               // current user
    invalidateFriendCache(friendship.requesterId);

    res.json({ message: "Friend request accepted", friendship });     // response with success message
  } catch (err) { next(err); }              // catch errors and pass to error handler
}



// ---------------- DECLINE FRIEND REQUEST CONTROLLER ----------------
export async function declineFriendRequest(req, res, next) {
  try {
    const { requestId } = req.params;                // Get friend request id from URL params "/:requestId"
    const userId = req.user.id;                      // Get current user id, from req.user (token payload)

    // Find and Update friendship status from 'PENDING' to 'DECLINED'
    const friendship = await prisma.friendship.update({ where: { id: requestId, receiverId: userId, status: 'PENDING' }, data: { status: 'DECLINED' } });

    // If friendship is not found, return with a message
    if (!friendship) { return res.status(404).json({ message: "Friend request not found" }); }

    // No new friendship, but remove any cached friend relation if it existed (was friends before)
    invalidateFriendCache(userId);
    invalidateFriendCache(friendship.requesterId);

    // response with success message and the requesterId (to update/revalidate the UI if needed)
    res.json({ message: "Friend request declined", requesterId: friendship.requesterId  });    
  } catch (err) { next(err); }                           // catch errors and pass to error handler
}



// ---------------- CANCEL FRIEND REQUEST CONTROLLER ----------------
export async function cancelFriendRequest(req, res, next) {
  try {
    const { requestId } = req.params;                 // Get friend request id from URL params "/:requestId" 
    const userId = req.user.id;                       // Get current user id, from req.user (token payload)

    // Delete pending friendship (only if requester is cancelling)
    const friendship = await prisma.friendship.delete({ where: { id: requestId, requesterId: userId, status: 'PENDING' } });
    
    // If friendship is not found, return with a message
    if (!friendship) { return res.status(404).json({ message: "Friend request not found" }); }

    // invalidate friend caches for both users 
    invalidateFriendCache(userId);
    invalidateFriendCache(friendship.receiverId);

    // response with success message and the receiverId (to update/revalidate the UI if needed)
    res.json({ message: "Friend request cancelled", receiverId: friendship.receiverId });   
  } catch (err) { next(err); }                           // catch errors and pass to error handler
}



// ---------------- REMOVE FRIEND (UNFRIEND) CONTROLLER ----------------
export async function removeFriend(req, res, next) {
  try {
    const { userId: friendId } = req.params;            // Get friend id from URL params "/:userId"
    const currentUserId = req.user.id;                  // Get current user id, from req.user (token payload)

    // Find existing accepted friendship (in any direction)
    const friendship = await prisma.friendship.findFirst({
       where: { OR: [ { requesterId: currentUserId, receiverId: friendId }, { requesterId: friendId, receiverId: currentUserId } ], status: 'ACCEPTED' } 
    });

    // If friendship is not found, return with a message
    if (!friendship) { return res.status(404).json({ message: "Friendship not found" }); }

    // Delete the friendship from db
    await prisma.friendship.delete({ where: { id: friendship.id } });

    // Invalidate caches for both users
    invalidateFriendCache(currentUserId);
    invalidateFriendCache(friendId);

    res.json({ message: "Friend removed" });          // response with success message
  } catch (err) { next(err); }                        // catch errors and pass to error handler
}



// ---------------- BLOCK USER CONTROLLER ----------------
export async function blockUser(req, res, next) {
  try {
    const { userId: targetId } = req.params;      // Get target user id from URL params "/:userId"
    const currentUserId = req.user.id;            // Get current user id, from req.user (token payload)

    // if target user id is same as current user id, return with a message "Cannot block yourself"
    if (targetId === currentUserId) { return res.status(400).json({ message: "Cannot block yourself" }) }

    // Check if target user exists, if not return with a message "User not found"
    const targetUser = await prisma.user.findUnique({ where: { id: targetId } });
    if (!targetUser) return res.status(404).json({ message: "User not found" });

    // Find existing friendship in any direction (sent or received)
    const existing = await prisma.friendship.findFirst({
      where: { OR: [{ requesterId: currentUserId, receiverId: targetId }, { requesterId: targetId, receiverId: currentUserId }] }
    });

    // If there is an existing friendship, update it to BLOCKED, otherwise create a new BLOCKED friendship
    let friendship;
    if (existing) {      
      friendship = await prisma.friendship.update({ where: { id: existing.id }, data: { status: 'BLOCKED' } });
    } else {      
      friendship = await prisma.friendship.create({ data: { requesterId: currentUserId, receiverId: targetId, status: 'BLOCKED' } });
    }

    // Invalidate caches for both users
    invalidateFriendCache(currentUserId);
    invalidateFriendCache(targetId);
    invalidateBlockedCache(currentUserId);
    invalidateBlockedCache(targetId);

    res.json({ message: "User blocked", friendship });   // response with success message and the friendship record
  } catch (err) { next(err); }                           // catch errors and pass to error handler
}



// ---------------- UNBLOCK USER ----------------
export async function unblockUser(req, res, next) {
  try {
    const { userId: targetId } = req.params;          // Get target user id from URL params "/:userId"
    const currentUserId = req.user.id;                // Get current user id, from req.user (token payload)

    // if target user id is same as current user id, return with a message "Cannot unblock yourself"
    if (targetId === currentUserId) { return res.status(400).json({ message: "Cannot unblock yourself" }) }

    // Find the BLOCKED friendship
    const friendship = await prisma.friendship.findFirst({
      where: { status: 'BLOCKED', OR: [{ requesterId: currentUserId, receiverId: targetId }, { requesterId: targetId, receiverId: currentUserId }] }
    });

    // If friendship is not found, return with a message
    if (!friendship) { return res.status(404).json({ message: "Block not found" }) }

    // Delete the friendship record (unblock = remove "BLOCKED" friendship)
    await prisma.friendship.delete({ where: { id: friendship.id } });

    // Invalidate caches for both users
    invalidateBlockedCache(currentUserId);
    invalidateBlockedCache(targetId);

    res.json({ message: "User unblocked" });             // response with success message
  } catch (err) { next(err); }                           // catch errors and pass to error handler
}



// ---------------- GET MY FRIENDS CONTROLLER ----------------
export async function getMyFriends(req, res, next) {
  try {
    const userId = req.user.id;                         // Get current user id, from req.user (token payload)
    const limit = parseInt(req.query.limit) || 50;      // get limit from URL query OR default to 50
    const cursor = req.query.cursor;                    // get cursor from URL query (for infinite scroll)
    const q = req.query.q?.trim();                      // get search query from URL query (for filtering friends by name)

    // Get accepted friendships where user is either requester or receiver
    const friendships = await prisma.friendship.findMany({
      take: limit + 1,                                  // +1 to check if there are more friendships after the limit
      skip: cursor ? 1 : 0,                             // skip the extra friendship if there is a cursor
      cursor: cursor ? { id: cursor } : undefined,      // set the cursor indicator
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // order by creation date (descending) + id (to ensure consistent order when createdAt is the same)
      where: { status: "ACCEPTED", OR: [{ requesterId: userId }, { receiverId: userId }], ...(q && { AND: [{ OR: [{ requester: { name: { contains: q, mode: "insensitive" } } }, { receiver: { name: { contains: q, mode: "insensitive" } } } ]} ] }) },
      include: { requester: { select: { id: true, name: true, image: true, bio: true }}, receiver: { select: { id: true, name: true, image: true, bio: true }} },
    });

    // Extract & normalize friends (the other user in each friendship)
    const friends = friendships.map(f => {
      const friend = f.requesterId === userId ? f.receiver : f.requester;
      return { ...friend, friendshipId: f.id };
    });

    // Check if there are more friendships after the limit, set next cursor
    let nextCursor = null;
    if (friendships.length > limit) { nextCursor = friendships[limit-1].id; friends.pop(); }

    res.json({ friends, nextCursor });                // response with friends and next cursor
  } catch (err) { next(err); }                        // catch errors and pass to error handler
}



// ---------------- GET FRIEND REQUESTS CONTROLLER ----------------
export async function getFriendRequests(req, res, next) {
  try {
    const userId = req.user.id;                     // Get current user id, from req.user (token payload)
    const type = req.query.type || 'received';      // 'received', 'sent', or 'all'
    const limit = parseInt(req.query.limit) || 20;  // get limit from URL query OR default to 20
    const cursor = req.query.cursor;                // get cursor from URL query (for infinite scroll)

    // Build where clause filters based on type
    let where = { status: 'PENDING' };    
    if (type === 'received') {
      where.receiverId = userId;
    } else if (type === 'sent') {
      where.requesterId = userId;
    } else if (type === 'all') {
      where.OR = [{ receiverId: userId }, { requesterId: userId }];
    }

    // Get friend requests
    const requests = await prisma.friendship.findMany({
      take: limit + 1,                                  // +1 to check if there are more requests after the limit
      skip: cursor ? 1 : 0,                             // skip the extra request if there is a cursor
      cursor: cursor ? { id: cursor } : undefined,      // set the cursor indicator
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // order by creation date (descending) + id (to ensure consistent order when createdAt is the same)
      where,                                            // apply filters
      include: { requester: { select: { id: true, name: true, image: true, bio: true } }, receiver: { select: { id: true, name: true, image: true, bio: true } } }      
    });

    // check if there are more requests after the limit, set next cursor
    let nextCursor = null;
    if (requests.length > limit) { nextCursor = requests[limit-1].id; requests.pop(); }

    res.json({ requests, nextCursor });             // response with requests and next cursor
  } catch (err) { next(err); }                      // catch errors and pass to error handler
}



// ---------------- GET FRIEND SUGGESTIONS CONTROLLER ----------------
export async function getFriendSuggestions(req, res, next) {
  try {
    const userId = req.user.id;                         // Get current user id, from req.user (token payload)
    const limit = parseInt(req.query.limit) || 10;      // get limit from URL query OR default to 10

    // Get accepted friendships where user is either requester or receiver
    const userFriendships = await prisma.friendship.findMany({
      where: { status: 'ACCEPTED', OR: [ { requesterId: userId }, { receiverId: userId } ]},
      select: { requesterId: true, receiverId: true }
    });

    // Extract the IDs
    const friendIds = userFriendships.map(f => f.requesterId === userId ? f.receiverId : f.requesterId );
    // Add current user ID & his current friends IDs to exclude list
    const excludeIds = [...friendIds, userId];

    // Get friends of friends (mutual connections) & append the exclude list
    const mutualConnections = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [ { requesterId: { in: friendIds } }, { receiverId: { in: friendIds } } ],
        NOT: { OR: [{ requesterId: { in: excludeIds } }, { receiverId: { in: excludeIds } }] }
      },
      select: { requesterId: true, receiverId: true },
      take: 100       // Limit for performance
    });

    // Build candidate set, excluding already excluded IDs 
    const candidateIds = new Set();
    mutualConnections.forEach(f => {
      if (!excludeIds.includes(f.requesterId)) candidateIds.add(f.requesterId);
      if (!excludeIds.includes(f.receiverId)) candidateIds.add(f.receiverId);
    });

    // Fallback: random users if needed
    if (candidateIds.size < limit) {
      const randomUsers = await prisma.user.findMany({
        where: { id: { notIn: [...excludeIds, ...candidateIds] }, friendshipsRequested: { none: { receiverId: userId, status: 'PENDING' } }, friendshipsReceived: { none: { requesterId: userId, status: 'PENDING' } }},
        select: { id: true },
        take: limit - candidateIds.size
      });
      randomUsers.forEach(u => candidateIds.add(u.id));       // add to potential friends 
    }
    const candidateArray = Array.from(candidateIds);          // convert set to array

    // FETCH ALL MUTUAL COUNTS IN ONE QUERY
    const mutualCounts = await prisma.friendship.groupBy({
      by: ['requesterId', 'receiverId'],
      where: { status: 'ACCEPTED', OR: [ { requesterId: { in: candidateArray }, receiverId: { in: friendIds } }, { receiverId: { in: candidateArray }, requesterId: { in: friendIds } } ] },
      _count: true
    });

    // Build lookup map, { key: candidateId, value: mutual count }
    const mutualMap = {};
    mutualCounts.forEach(m => {
      const candidateId = friendIds.includes(m.requesterId) ? m.receiverId : m.requesterId;
      mutualMap[candidateId] = (mutualMap[candidateId] || 0) + 1;
    });

    // Fetch user details for candidates
    const suggestions = await prisma.user.findMany({ where: { id: { in: candidateArray } }, select: { id: true, name: true, image: true, bio: true }, take: limit });

    // Attach mutual count, map over suggestions and sort by mutual count
    const result = suggestions.map(u => ({ ...u, mutualFriendsCount: mutualMap[u.id] || 0 })).sort((a, b) => b.mutualFriendsCount - a.mutualFriendsCount);

    res.json({ suggestions: result.slice(0, limit) });   // response with suggestions
  } catch (err) {  next(err); }                          // catch errors and pass to error handler}
}



// ---------------- GET BLOCKED USERS CONTROLLER ----------------
export async function getBlockedUsers(req, res, next) {
  try {
    const userId = req.user.id;                       // Get current user id, from req.user (token payload)
    const limit = parseInt(req.query.limit) || 20;    // get limit from URL query OR default to 20
    const cursor = req.query.cursor;                  // get cursor from URL query (for infinite scroll)

    // Get blocked friendships where user is either requester or receiver
    const friendships = await prisma.friendship.findMany({
      take: limit + 1,                                  // +1 to check for more
      skip: cursor ? 1 : 0,                             // skip the extra record if there is a cursor
      cursor: cursor ? { id: cursor } : undefined,      // set the cursor indicator
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // order by creation date (descending) + id (to ensure consistent order when createdAt is the same)
      where: { status: 'BLOCKED', OR: [{ requesterId: userId }, { receiverId: userId }] },
      include: {
        requester: { select: { id: true, name: true, image: true, bio: true } },
        receiver: { select: { id: true, name: true, image: true, bio: true } }
      }
    });

    // Extract the blocked user (the other participant)
    const blockedUsers = friendships.map(f => {
      const blocked = f.requesterId === userId ? f.receiver : f.requester;
      return { ...blocked, friendshipId: f.id };   // keep friendshipId for unblock
    });

    // check if there are more requests after the limit, set next cursor
    let nextCursor = null;
    if (friendships.length > limit) { nextCursor = friendships[limit-1].id; blockedUsers.pop(); }

    res.json({ users: blockedUsers, nextCursor });   // response with blocked users and next cursor
  } catch (err) { next(err); }                       // catch errors and pass to error handler
}



// ---------------- GET A FRIENDSHIP STATUS CONTROLLER ----------------
export async function getFriendshipStatus(req, res, next) {
  try {
    const { userId: targetId } = req.params;         // Get target user id from URL params "/:userId"
    const currentUserId = req.user.id;               // Get current user id, from req.user (token payload)
    
    // If no target user id provided, return with a message "Missing userId"
    if (!targetId) return res.status(400).json({ message: "Missing userId" });

    // Get the friendship between current user and target user
    const friendship = await prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: currentUserId, receiverId: targetId },
          { requesterId: targetId, receiverId: currentUserId }
        ]
      }
    });

    // If no friendship found, return with status null (treat as no friendship)
    if (!friendship) return res.json({ status: null });

    // Get the direction of the friendship (sent or received)
    const direction = friendship.requesterId === currentUserId ? 'sent' : 'received';

    // Respond with the friendship status, id and direction
    res.json({ status: friendship.status, friendshipId: friendship.id, direction });   
  } catch (err) { next(err); }                // catch errors and pass to error handler
}



// ---------------- REMOVE TAG (UNTAG USER) CONTROLLER ----------------
export async function removeTag(req, res, next) {
  try {
    const { tagId } = req.params;                // Get tag id from URL params
    const userId = req.user.id;                  // Get current user id, from req.user (token payload)

    // Find the tag in the database, including tagged, taggedBy, post and comment
    const tag = await prisma.tag.findUnique({ where: { id: tagId }, include: { tagged: true, taggedBy: true, post: true, comment: true } });
    // If tag is not found, return with a message "Tag not found"
    if (!tag) { return res.status(404).json({ message: "Tag not found" }); }

    // Check permissions: tagged user or person who tagged or admin
    const canRemove = 
      tag.taggedId === userId || 
      tag.taggedById === userId || 
      req.user.role === 'admin' ||
      (tag.post && tag.post.authorId === userId) ||
      (tag.comment && tag.comment.userId === userId);
    // If not authorized, return with a message "Not authorized to remove this tag"
    if (!canRemove) { return res.status(403).json({ message: "Not authorized to remove this tag" }); }

    // Create a prisma transaction to Delete the tag and send notification using the notification helper
    await prisma.$transaction([
      prisma.tag.delete({ where: { id: tagId } }),
      prisma.notification.deleteMany({ where: { tagId, type: 'TAG' } }),
    ]);

    res.json({ message: "Tag removed successfully" });        // respond with success message
  } catch (err) { next(err); }                                // catch errors and pass to error handler
}