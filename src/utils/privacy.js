import { prisma } from "../prisma.js";

//-----------------------------------------------
// Build Prisma WHERE filter for ALL posts queries
//-----------------------------------------------
export function buildPrivacyFilter(currentUserId = null, friendIds = [], blockedIds = []) {
  // Non-logged users → only PUBLIC posts
  if (!currentUserId) {
    return { privacy: "PUBLIC" };
  }

  // Current user is the author - they can see all their own posts
  return {
    AND: [
      // Exclude posts FROM blocked users completely
      {
        NOT: {
          authorId: { in: blockedIds }
        }
      },
    {  
      OR: [
        // 1. Author can always see their own posts
        { authorId: currentUserId },

        // 2. PUBLIC posts (not [post-level] privacy blocked)
        {
          AND: [
            { privacy: "PUBLIC" },
            { NOT: { blocked: { has: currentUserId } } }
          ]
        },

        // 3. FRIENDS posts
        {
          AND: [
            { privacy: "FRIENDS" },
            { authorId: { in: friendIds } },
            { NOT: { blocked: { has: currentUserId } } }
          ]
        },

        // 4. CUSTOM → user must be in allowed[], and not in blocked[]
        {
          AND: [
            { privacy: "CUSTOM" },
            { allowed: { has: currentUserId } },
            { NOT: { blocked: { has: currentUserId } } }
          ]
        }
      ]
    }]
  };
}


// -------------------------------------------------------
// Validate visibility for a SINGLE POST (GET /posts/:id)
// -------------------------------------------------------
export function canUserViewPost(post, currentUserId = null, friendIds = [], blockedIds = []) {
  // Post Not found?
  if (!post) return false;

  // Author is the current user - override
  if (currentUserId && post.authorId === currentUserId) {
    return true;
  }

  // Blocked friendship check
  if (blockedIds.includes(post.authorId)) {
    return false;
  }

  // Post-level block check (e.g., author select current user for the blocked array)
  if (currentUserId && post.blocked.includes(currentUserId)) {
    return false;
  }

  switch (post.privacy) {
    case "PUBLIC":
      return true;

    case "FRIENDS":
      return currentUserId && friendIds.includes(post.authorId);

    case "ONLY_ME":
      return false; // Already handled by author check above

    case "CUSTOM":
      return (
        currentUserId &&
        post.allowed.includes(currentUserId) &&
        !post.blocked.includes(currentUserId)
      );

    default:
      return false;
  }
}


// -------------------------------------------------------
// Get list of friends for a USER 
// -------------------------------------------------------
export async function getFriendIds(userId) {
  if (!userId) return [];

  const rows = await prisma.friendship.findMany({
    where: {
      status: "ACCEPTED",
      OR: [
        { requesterId: userId },
        { receiverId: userId }   
      ]
    },
    select: {
      requesterId: true,
      receiverId: true
    }
  });

  return rows.map(r =>  r.requesterId === userId ? r.receiverId : r.requesterId );
}


// -------------------------------------------------------
// OPTIONAL: Cache friend IDs for performance
// -------------------------------------------------------
const friendCache = new Map();

export async function getFriendIdsCached(userId, useCache = true) {
  if (!userId) return [];
  
  if (useCache && friendCache.has(userId)) { return friendCache.get(userId); }
  
  const friendIds = await getFriendIds(userId);
  
  if (useCache) {
    friendCache.set(userId, friendIds);
    // Clear cache after 5 minutes
    setTimeout(() => friendCache.delete(userId), 5 * 60 * 1000);
  }
  
  return friendIds;
}



// -------------------------------------------------------
// Get list of blocked users (both directions)
// -------------------------------------------------------
export async function getBlockedUserIds(userId) {
  if (!userId) return [];

  const rows = await prisma.friendship.findMany({
    where: {
      status: "BLOCKED",
      OR: [
        { requesterId: userId },
        { receiverId: userId }
      ]
    },
    select: {
      requesterId: true,
      receiverId: true
    }
  });

  return rows.map(r => r.requesterId === userId ? r.receiverId : r.requesterId );
}


// -------------------------------------------------------
// OPTIONAL: Cache blocked user IDs for performance
// -------------------------------------------------------
const blockedCache = new Map();

export async function getBlockedUserIdsCached(userId, useCache = true) {
  if (!userId) return [];

  if (useCache && blockedCache.has(userId)) {
    return blockedCache.get(userId);
  }

  const blockedIds = await getBlockedUserIds(userId);

  if (useCache) {
    blockedCache.set(userId, blockedIds);

    // Clear cache after 2 minutes
    setTimeout(() => blockedCache.delete(userId), 2 * 60 * 1000);
  }

  return blockedIds;
}




// -------------------------------------------------------
// Invalidate caches when friendships change (e.g., new friend, block, unblock)
// -------------------------------------------------------
export function invalidateFriendCache(userId) {
  friendCache.delete(userId);
}

export function invalidateBlockedCache(userId) {
  blockedCache.delete(userId);
}