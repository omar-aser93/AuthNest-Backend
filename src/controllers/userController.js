import { prisma } from '../prisma.js';
import { getIO } from '../socket/index.js';
import { uploadToCloudinary } from "../utils/uploadToCloudinary.js";
import { hashItem, compareHashed } from "../utils/hash.js";
import { getBlockedUserIdsCached } from '../utils/privacy.js';
import { deleteCommentsCascade, deletePostsCascade, deleteMessagesCascade, deleteCallsCascade } from '../utils/cascadeDelete.js';
import { sanitizeText } from '../utils/XSS-sanitization.js';


// ---------------- CURRENT USER PROFILE CONTROLLER ----------------
export async function getMyProfile(req, res, next) {
  try {
    // find user by id from req.user (set in auth middleware by decoding the token)
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, name: true, email: true, password: true, image: true, bio : true, role: true, savedPosts: { select: { postId: true } }, isEmailVerified: true, emailVerifyExpiry: true }
    });
    if (!user) return res.status(404).json({ message: 'Not found' });  // if user not found, return 404 "Not found"
    const { password, ...data} = user;     // extract password and return the rest
    res.json({...data, hasPassword: Boolean(password)});  // respond with user data
  } catch (err) { next(err); }             // catch errors and pass to error handler
}



// ---------------- GET MY STATS CONTROLLER ----------------
export async function getMyStats(req, res, next) {
  try {
    const userId = req.user.id;             // get user id from req.user (token payload)
    // count posts, saved posts and friends
    const [postsCount, savedPostsCount, friendsCount] = await Promise.all([
      prisma.post.count({ where: { authorId: userId } }),
      prisma.savedPost.count({ where: { userId } }),
      prisma.friendship.count({ where: { status: 'ACCEPTED', OR: [{ requesterId: userId }, { receiverId: userId }] } }),
    ]);
    // respond with the stats
    res.json({ postsCount, savedPostsCount, friendsCount });
  } catch (err) { next(err); }          // catch errors and pass to error handler
}



// ---------------- GET A USER BY ID CONTROLLER ----------------
export async function getUserById(req, res, next) {
  try {
    // find user by id from req.params.id
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, image: true, bio: true, createdAt: true }
    });    
    if (!user) return res.status(404).json({ message: 'Not found' });  // if user not found, return 404 "Not found"
    res.json(user);                   // respond with user
  } catch (err) { next(err); }        // catch errors and pass to error handler
}



// ---------------- UPDATE USER CONTROLLER ----------------
export async function updateUser(req, res, next) {
  try {
    const { id } = req.params;            // get user id from params
    // allow only owner or admin
    if (req.user.id !== id && req.user.role !== "admin") { return res.status(403).json({ message: "Forbidden" }); }

    // prepare data object for update
    const data = {};
    if (req.body.name) data.name = req.body.name;             // update name if provided
    // update bio if provided (sanitize it)
    if (typeof req.body.bio === "string") data.bio = sanitizeText(req.body.bio) || null;
    // Handle image upload (req.file)
    if (req.file) {
      const uploaded = await uploadToCloudinary(req.file.path, "users");
      data.image = uploaded.url;      
    }

    // update user data in db
    const updated = await prisma.user.update({ where: { id }, data,
      select: { id: true, name: true, email: true, image: true, bio: true, role: true, savedPosts: { select: { postId: true } }, isEmailVerified: true, emailVerifyExpiry: true,  password: true }
    });
   
    const { password, ...rest } = updated;                 // extract password and return the rest
    res.json({ ...rest, hasPassword: Boolean(password) }); // respond with updated user info
  } catch (err) {
    next(err);                  // catch errors and pass to error handler
  }
}



// ---------------- CHANGE PASSWORD (FROM PROFILE) CONTROLLER ----------------
export async function changePassword(req, res, next) {
  try {
    // Get user id from req params and passwords from req body
    const { id } = req.params;
    const { currentPassword, newPassword } = req.body;

    // Ensure owner or admin
    if (req.user.id !== id && req.user.role !== "admin") { return res.status(403).json({ message: "Forbidden" }); }

    // Fetch user from DB, if not found return 404 "Not found"
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return res.status(404).json({ message: "User not found" });
    // If user was created via social login (no password), disallow password change
    if (!user.password) { return res.status(400).json({ message: "This account uses social sign-in. No password to change." });} 
   
    // verify current password, compare received password with the hashed password in DB
    const isMatch = await compareHashed(currentPassword, user.password);
    if (!isMatch) return res.status(400).json({ message: "Wrong current password" });

    // Hash the new password and update the user in DB & clear sessions
    const hashed = await hashItem(newPassword);
    await prisma.user.update({ where: { id }, data: { password: hashed } });
    await prisma.session.deleteMany({ where: { userId: id } });
    getIO()?.in(`user:${id}`).disconnectSockets(true);             // disconnect all sockets for this user
    
    res.json({ message: "Password updated successfully" });        // respond with success message
  } catch (err) { next(err);  }               // catch errors and pass to error handler
}




// ---------------- DELETE USER CONTROLLER ----------------
export async function deleteUser(req, res, next) {
  try {
    const { id } = req.params;            // get user id from params

    // Fetch user from DB, if not found return 404 "Not found"
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) return res.status(404).json({ message: "User not found" });
    // Allow only self-deletion or admin-initiated deletion
    if (req.user.id !== id && req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    
    // Cascade delete the user & his related data, We use the helper utilities from cascadeDelete.js
    await prisma.$transaction(async (tx) => {
      // ── collect all the posts the user authored ─────────────────────────────────────
      const posts = await tx.post.findMany({ where: { authorId: id }, select: { id: true } });
      const postIds = posts.map((p) => p.id);

      // Delete the Comments the user made on OTHER people's posts (with their reply chains)
      const userCommentsOnOthers = await tx.comment.findMany({ where: { userId: id, postId: { notIn: postIds } }, select: { id: true }, });
      await deleteCommentsCascade(tx, userCommentsOnOthers.map((c) => c.id));

      // Delete The user's own posts (with all comments, replies, reactions, etc.)
      await deletePostsCascade(tx, postIds);

      await tx.session.deleteMany({ where: { userId: id } });      // Delete sessions

      // ── Delete Remaining references to the user ──────────────────────────────
      await tx.tag.deleteMany({ where: { OR: [{ taggedId: id }, { taggedById: id }] } });
      await tx.editHistory.deleteMany({ where: { editorId: id } });
      await tx.notification.deleteMany({ where: { OR: [{ userId: id }, { senderId: id }] } });
      await tx.friendship.deleteMany({ where: { OR: [{ requesterId: id }, { receiverId: id }] } });
      
      // Only delete reports the user made or was the target of
      await tx.report.deleteMany({ where: { OR: [{ reporterId: id }, { targetType: "USER", targetId: id }] }, });
      // Keep the review record but detach the reviewer (if admin account is deleted, it will keep the history of the reports he reviewed)
      await tx.report.updateMany({ where: { reviewedById: id }, data: { reviewedById: null }, });
      // Detach the deleted user from any bans they issued (audit trail preserved on the banned users)
      await tx.user.updateMany({ where: { bannedById: id }, data: { bannedById: null }});

      // ── Delete Chats messages related data (not the chat itself) ──────────────────────────────────────────────────────────
      await tx.messageRead.deleteMany({ where: { userId: id } });
      await tx.messageReaction.deleteMany({ where: { userId: id } });
      await tx.conversationParticipant.deleteMany({ where: { userId: id } });

      // Delete User's own messages (no Cloudinary cleanup on user delete — orphaned assets are acceptable; keeping it fast matters more)
      const messages = await tx.message.findMany({ where: { senderId: id }, select: { id: true } });
      await deleteMessagesCascade(tx, messages.map((m) => m.id));

      // ── Delete Calls ─────────────────────────────────────────────────────────
      await tx.callParticipant.deleteMany({ where: { userId: id } });  // user's participations
      const calls = await tx.call.findMany({ where: { callerId: id }, select: { id: true } });
      await deleteCallsCascade(tx, calls.map((c) => c.id));            // calls user started (with all participants)

      // ── Finally, Delete the user himself ─────────────────────────────────────────────
      await tx.user.delete({ where: { id } });
    });

    // Disconnect all sockets of the user
    const io = getIO();
    if (io) io.in(`user:${id}`).disconnectSockets(true);

    res.json({ message: 'User Deleted' });               // respond with success message
  } catch (err) { next(err); }                           // catch errors and pass to error handler
}



// ---------------- SEARCH USERS FOR MENTION CONTROLLER (Limit to 8 mentions) ----------------
export async function searchUsersForMention(req, res, next) {
  try {
    const q = req.query.q?.trim();      // get search query from req.query and trim whitespace
    if (!q) return res.json([]);        // if no query, return empty array
    const currentUserId = req.user.id;  // get current user id from req.user (token payload)

    // search users by name that is containing the query (case insensitive), No self mention
    const users = await prisma.user.findMany({
      where: { AND: [ { id: { not: currentUserId } }, { name: { contains: q, mode: 'insensitive' } } ] },
      select: { id: true, name: true, image: true },
      take: 8                        // limit to 8 results
    });

    res.json(users);                 // respond with found users
  } catch (err) {  next(err); }      // catch errors and pass to error handler
}



//  ---------------- SEARCH USERS CONTROLLER (Global Search FOR ADDING FRIENDS, ETC) ----------------
export async function searchUsers(req, res, next) {
  try {
    const q = req.query.q?.trim();                   // get search query from req.query and trim whitespace
    const limit = parseInt(req.query.limit) || 20;   // get limit from req.query OR default to 20
    const cursor = req.query.cursor;                 // get cursor from req.query (for pagination)
    const currentUserId = req.user?.id;              // get current user id from req.user (token payload)

    if (!q) return res.json({ users: [], nextCursor: null });     // if no query, return empty array
    // if query less than 2 characters, return empty array (to avoid unnecessary DB load and meaningless search)
    if (q && q.length < 2) { return res.json({ users: [], nextCursor: null }); }  

    // where clause to search users by name containing the query (case insensitive)
    let where = { name: { contains: q, mode: "insensitive" } };    
    // Only exclude self & blocked users if user is logged in
    if (currentUserId) {
      const blockedIds = await getBlockedUserIdsCached(currentUserId);
      where.id = { notIn: [currentUserId, ...blockedIds] };
    } 

    // search users by name containing the query (case insensitive), with pagination (cursor-based)
    const users = await prisma.user.findMany({
      take: limit + 1,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      where,
      select: { id: true, name: true, image: true, bio: true }
    });

    // if there are more users than the limit, set nextCursor to the id of the last user and remove it from the results
    let nextCursor = null;
    if (users.length > limit) { nextCursor = users[limit].id; users.pop(); }

    res.json({ users, nextCursor });           // respond with found users and nextCursor for pagination
  } catch (err) { next(err); }                 // catch errors and pass to the error handler
}