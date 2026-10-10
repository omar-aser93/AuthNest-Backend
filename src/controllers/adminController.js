import { compareHashed } from '../utils/hash.js';
import { verifyRefreshToken } from '../utils/token.js';
import { createSession, setAuthCookies, clearAuthCookies } from '../utils/sessionHelper.js';
import { enrichReportsWithTargets } from '../utils/reportHelper.js';
import { prisma } from '../prisma.js';
import { getIO } from '../socket/index.js';


// ─────────────────────────────────────────────────────────────────────────────
// ADMIN LOGIN CONTROLLER
// Separate from the user login controller on purpose:
//   - User login returns tokens in the body (Next.js server action sets cookies)
//   - Admin login sets cookies directly (SPA react has no server to do it)
//   - Admin login rejects non-admin users at the auth step
// ─────────────────────────────────────────────────────────────────────────────
export async function adminLogin(req, res, next) {
  try {
    const { email, password, remember } = req.body;       // extract (email, password and remember-me flag)
    // find user by email, if not found return 401 "invalid credentials"
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });
    // If user was created via social login (no password), disallow password login
    if (!user.password) {
      return res.status(403).json({ message: 'Account registered via social login. Admin login must use Email/Password.' });
    }
    // compare password with hashed password, if not match return 401 "invalid credentials"
    const ok = await compareHashed(password, user.password);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

    // ── Admin gate — reject before issuing tokens ───────────────────────────
    if (user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized for admin access' });
    }
    
    // if user is banned by another admin, return 403 "Your account has been suspended"
    if (user.bannedAt) return res.status(403).json({ message: 'Your account has been suspended' });

    // create session & set cookies - using the helper function 
    const { accessToken, refreshToken, refreshExpiryDays } = await createSession({ userId: user.id, role: user.role, remember: !!remember,  req });
    setAuthCookies(res, { accessToken, refreshToken, refreshExpiryDays });

    // respond with Admin info and remember-me flag (no need to return tokens)
    res.json({ user: { id: user.id, name: user.name, email: user.email, image: user.image, role: user.role }, remember });
  } catch (err) { next(err); }      // catch errors and pass to error handler
}



// ─────────────────────────────────────────────────────────────────────────────
// ADMIN LOGOUT
// Same DB cleanup as the user logout, but also clears the accessToken cookie.
// The user logout only clears refreshToken because the Next.js client cleans its own cookies server-side. 
// The admin React SPA has no server layer, so it needs the backend to clear all three.
// ─────────────────────────────────────────────────────────────────────────────
export async function adminLogout(req, res, next) {
  try {    
    // Always clear cookies first — even if there's no token, stale cookies may still exist on the client
    clearAuthCookies(res);

    // read the refresh token from the cookie, if no token → nothing to delete from the DB, cookies already cleared
    const token = req.cookies.refreshToken;
    if (!token) return res.json({ message: 'Logged out' });

    // if refresh token present, verify it, then clear DB refresh token by user id
    if (token) {
      try {
        const payload = verifyRefreshToken(token);
        if (payload.sid) {
          await prisma.session.deleteMany({
            where: { sessionId: payload.sid, userId: payload.sub },
          });
        }
      } catch { /* invalid token — proceed to clear cookies */ }
    }

    res.json({ message: "Logged out" });    // respond with logout success 
  } catch (err) { next(err) }               // catch errors and pass to error handler
}



// ---------------- LIST USERS (paginated, searchable, filterable) ----------------
export async function adminListUsers(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);                    // simple offset pagination
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));   // limit max to 50
    const search = req.query.search?.trim() || "";                   // search query
    const role = req.query.role;                                     // filter by role
    const sort = req.query.sort || "createdAt";                      // sort by recieved query or createdAt
    const order = req.query.order === "asc" ? "asc" : "desc";        // sort order, default to desc

    // Whitelist sortable fields to prevent Prisma errors from arbitrary input
    const orderByField = ["createdAt", "name", "email", "role"].includes(sort) ? sort : "createdAt";

    // build where clause
    const where = {};
    if (search) {
      where.OR = [
        { name:  { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }
    if (role === "user" || role === "admin") where.role = role;

    // fetch users and total count
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { [orderByField]: order },
        select: { id: true, name: true, email: true, image: true, role: true, isEmailVerified: true, createdAt: true, bannedAt: true, bannedReason: true },
      }),
      prisma.user.count({ where }),
    ]);

    // respond with users, total, page, limit, and totalPages
    res.json({ users, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) { next(err); }        // catch errors and pass to error handler
}



// ---------------- UPDATE USER ROLE (promote / demote) ----------------
export async function updateUserRole(req, res, next) {
  try {
    const { id } = req.params;                    // get user id from params
    const { role } = req.body;                    // get role from request body

    // Prevent self-demotion — otherwise you can lock yourself out
    if (req.user.id === id && role !== "admin") {
      return res.status(400).json({ message: "You cannot demote yourself" });
    }

    // Verify the user exists before updating
    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, bannedAt: true } });
    if (!existing) return res.status(404).json({ message: "User not found" });
    // Prevent demoting the last active admin
    if (existing.role === "admin" && !existing.bannedAt && role === "user") {
      const activeAdmins = await prisma.user.count({ where: { role: "admin", bannedAt: null } });
      if (activeAdmins <= 1) return res.status(400).json({ message: "Cannot demote the last active admin" });
    }

    // Update the user
    const updated = await prisma.user.update({
      where: { id },
      data: { role },   // note: we do NOT null refreshToken, we don't want to log the user out from the website
      select: { id: true, name: true, email: true, image: true, role: true },
    });

    res.json(updated);                    // respond with updated user
  } catch (err) { next(err); }            // catch errors and pass to error handler
}



// ---------------- BAN USER ----------------
export async function banUser(req, res, next) {
  try {
    const { id } = req.params;                // get user id from params
    const { reason } = req.body;              // get reason from request body

    // Prevent self-ban — otherwise you can lock yourself out
    if (req.user.id === id) {
      return res.status(400).json({ message: "You cannot ban yourself" });
    }

    // Verify the user exists, if not found return 404, if already banned return 400
    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, bannedAt: true } });
    if (!existing) return res.status(404).json({ message: "User not found" });
    if (existing.bannedAt) return res.status(400).json({ message: "User is already banned" });

    // Prevent banning the last active admin — protects against a fully locked panel
    if (existing.role === "admin") {
      const activeAdmins = await prisma.user.count({
        where: { role: "admin", bannedAt: null },
      });
      if (activeAdmins <= 1) {
        return res.status(400).json({ message: "Cannot ban the last active admin" });
      }
    }

    // Update the user, set bannedAt and bannedReason
    const updated = await prisma.user.update({
      where: { id },
      data: { bannedAt: new Date(), bannedReason: reason || null, bannedById: req.user.id },
      select: { id: true, name: true, email: true, image: true, role: true, bannedAt: true, bannedReason: true },
    });

    // Kill EVERY session for this user — all browsers, all devices, immediately.
    await prisma.session.deleteMany({ where: { userId: id } });

    // Disconnect all sockets for this user
    const io = getIO();
    if (io) io.in(`user:${id}`).disconnectSockets(true);

    res.json(updated);                    // respond with updated user
  } catch (err) { next(err); }            // catch errors and pass to error handler
}



// ---------------- UNBAN USER ----------------
export async function unbanUser(req, res, next) {
  try {
    const { id } = req.params;           // get user id from params
    // Verify the user exists, if not found return 404
    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return res.status(404).json({ message: "User not found" });
    // Update the user
    const updated = await prisma.user.update({
      where: { id },
      data: { bannedAt: null, bannedReason: null, bannedById: null },
      select: { id: true, name: true, email: true, image: true, role: true, bannedAt: true, bannedReason: true },
    });

    res.json(updated);                 // respond with updated user
  } catch (err) { next(err); }         // catch errors and pass to error handler
}



// --------- Admin LIST POSTS (unlike user listPosts, no privacy filter, sees everything) -----------
export async function adminListPosts(req, res, next) {
  try {
    // get pagination, search, privacy, and sort parameters
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const search = req.query.search?.trim() || "";
    const privacy = req.query.privacy;
    const sort = req.query.sort || "createdAt";
    const order = req.query.order === "asc" ? "asc" : "desc";
    const orderByField = ["createdAt", "reactionCount", "commentCount", "shareCount"].includes(sort) ? sort : "createdAt";

    // build where clause
    const where = {};
    if (search) where.OR = [
      { title:   { contains: search, mode: "insensitive" } },
      { content: { contains: search, mode: "insensitive" } },
    ];
    if (["PUBLIC", "FRIENDS", "ONLY_ME", "CUSTOM"].includes(privacy)) where.privacy = privacy;

    // fetch posts and total count
    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { [orderByField]: order },
        select: {
          id: true, title: true, content: true, image: true, privacy: true,
          reactionCount: true, commentCount: true, shareCount: true, createdAt: true,
          author: { select: { id: true, name: true, email: true, image: true } },
        },
      }),
      prisma.post.count({ where }),
    ]);

    // respond with posts, total, page, limit, and totalPages
    res.json({ posts, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) { next(err); }            // catch errors and pass to error handler
}



// ---------------- GET POST BY ID (Admin) — bypasses privacy filter unlike user --------------
export async function adminGetPostById(req, res, next) {
  try {
    // fetch post
    const post = await prisma.post.findUnique({
      where: { id: req.params.id },
      include: {
        author: { select: { id: true, name: true, email: true, image: true } },
        tags: { include: { tagged: { select: { id: true, name: true, image: true } } } },
        originalPost: { include: { author: { select: { id: true, name: true, image: true } } } },
        _count: { select: { editHistory: true, comments: true } },
      },
    });
    if (!post) return res.status(404).json({ message: "Post not found" });   // if not found return 404
    res.json(post);                           // respond with the post
  } catch (err) { next(err); }                // catch errors and pass to error handler
}



// ------------ LIST COMMENTS (Admin) — unlike user listComments -> no privacy, sees all -----------
export async function adminListComments(req, res, next) {
  try {
    // get pagination, search, postId, authorId, and sort parameters
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const search = req.query.search?.trim() || "";
    const postId = req.query.postId;
    const authorId = req.query.authorId;
    const sort = req.query.sort || "createdAt";
    const order = req.query.order === "asc" ? "asc" : "desc";
    const orderByField = ["createdAt", "reactionCount", "replyCount"].includes(sort) ? sort : "createdAt";

    // build where clause
    const where = {};
    if (search) where.content = { contains: search, mode: "insensitive" };
    if (postId) where.postId = postId;
    if (authorId) where.userId = authorId;

    // fetch comments and total count
    const [comments, total] = await Promise.all([
      prisma.comment.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { [orderByField]: order },
        select: {
          id: true,
          content: true,
          postId: true,
          parentId: true,
          reactionCount: true,
          replyCount: true,
          createdAt: true,
          user: { select: { id: true, name: true, email: true, image: true } },
          post: { select: { id: true, title: true } },
        },
      }),
      prisma.comment.count({ where }),
    ]);

    // respond with comments, total, page, limit, and totalPages
    res.json({ comments, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) { next(err); }            // catch errors and pass to error handler
}



// ---------------- GET COMMENT BY ID (Admin) — bypasses privacy unlike user ------------------
export async function adminGetCommentById(req, res, next) {
  try {
    // fetch comment by id
    const comment = await prisma.comment.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
        post: { select: { id: true, title: true, privacy: true, authorId: true } },
        parent: {
          select: {
            id: true, content: true,
            user: { select: { id: true, name: true, image: true } },
          },
        },
        _count: { select: { replies: true, reactions: true, editHistory: true } },
      },
    });

    if (!comment) return res.status(404).json({ message: "Comment not found" });  // if not found return 404
    res.json(comment);                       // respond with the comment
  } catch (err) { next(err); }               // catch errors and pass to error handler
}



// ---------------- LIST REPORTS (Admin queue) ----------------
export async function adminListReports(req, res, next) {
  try {
    // get pagination, status, targetType, reason, and sort parameters
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const status = req.query.status;
    const targetType = req.query.targetType;
    const reason = req.query.reason;
    const groupBy = req.query.groupBy;
    const sort = req.query.sort || "createdAt";
    const order = req.query.order === "asc" ? "asc" : "desc";

    // ── Grouped mode ────────────────────────────────────────────────────────
    if (groupBy === "target") {
      // Build the match stage from the same filters as the flat path
      const match = {};
      if (["PENDING", "REVIEWED", "ACTIONED", "DISMISSED"].includes(status)) match.status = status;
      if (["POST", "COMMENT", "USER"].includes(targetType)) match.targetType = targetType;
      if (["SPAM","HARASSMENT","HATE_SPEECH","VIOLENCE","NUDITY","FALSE_INFO","COPYRIGHT","IMPERSONATION","OTHER"].includes(reason)) {
        match.reason = reason;
      }

      const pipeline = [
        { $match: match },
        { $sort: { createdAt: -1 } },
        { $group: {
            _id: { targetType: "$targetType", targetId: "$targetId" },
            reportCount: { $sum: 1 },
            firstReportedAt: { $min: "$createdAt" },
            latestReport: { $first: "$$ROOT" },   // after the $sort, $first = newest
          },
        },
        { $project: {
            _id: 0,
            targetType: "$_id.targetType",
            targetId: "$_id.targetId",
            reportCount: 1,
            firstReportedAt: 1,
            latestReport: 1,
          },
        },
      ];

      // Sort the groups themselves by most recent or count
      const groupSort = sort === "status" ? { reportCount: -1 } : { firstReportedAt: order === "asc" ? 1 : -1 };
      pipeline.push({ $sort: groupSort });
      pipeline.push({ $skip: (page - 1) * limit });
      pipeline.push({ $limit: limit });

      // Run the aggregation
      const result = await prisma.$runCommandRaw({ aggregate: "Report", pipeline, cursor: {}, });
      const groups = result.cursor.firstBatch ?? [];

      // Total groups (for pagination) — separate count aggregation
      const countResult = await prisma.$runCommandRaw({
        aggregate: "Report",
        pipeline: [
          { $match: match },
          { $group: { _id: { targetType: "$targetType", targetId: "$targetId" } } },
          { $count: "total" },
        ],
        cursor: {},
      });
      const total = countResult.cursor.firstBatch?.[0]?.total ?? 0;

      // Enrich each group's latest report with its target preview
      const enriched = await enrichReportsWithTargets( prisma, groups.map((g) => g.latestReport) );
      
      // Return the enriched groups
      const output = groups.map((g, i) => ({
        targetType: g.targetType,
        targetId: g.targetId,
        reportCount: g.reportCount,
        firstReportedAt: g.firstReportedAt,
        latestReport: { ...enriched[i], target: enriched[i].target },
      }));

      // respond with groups, total, page, limit, and totalPages
      return res.json({ groups: output, total, page, limit, totalPages: Math.ceil(total / limit) });
    }

    // ── Flat mode  ───────────────────────────────────────
    // configure order by field
    const orderByField = ["createdAt", "status"].includes(sort) ? sort : "createdAt";
    // build where clause
    const where = {};
    if (["PENDING", "REVIEWED", "ACTIONED", "DISMISSED"].includes(status)) where.status = status;
    if (["POST", "COMMENT", "USER"].includes(targetType)) where.targetType = targetType;
    if (["SPAM","HARASSMENT","HATE_SPEECH","VIOLENCE","NUDITY","FALSE_INFO","COPYRIGHT","IMPERSONATION","OTHER"].includes(reason)) {
      where.reason = reason;
    }
    // run query
    const [reports, total] = await Promise.all([
      prisma.report.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { [orderByField]: order },
        select: {
          id: true, targetType: true, targetId: true,
          reason: true, description: true, status: true,
          createdAt: true, reviewedAt: true, resolutionNote: true,
          reporter: { select: { id: true, name: true, email: true, image: true } },
          reviewedBy: { select: { id: true, name: true } },
        },
      }),
      prisma.report.count({ where }),
    ]);
    // enrich with targets & respond
    const enriched = await enrichReportsWithTargets(prisma, reports);
    res.json({ reports: enriched, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) { next(err); }         // catch errors and pass to error handler
}



// ---------------- GET REPORT BY ID (Admin) ----------------
export async function adminGetReportById(req, res, next) {
  try {
    // fetch report by id, including reporter and reviewedBy, IF not found return 404
    const report = await prisma.report.findUnique({
      where: { id: req.params.id },
      include: {
        reporter: { select: { id: true, name: true, email: true, image: true } },
        reviewedBy: { select: { id: true, name: true } },
      },
    });
    if (!report) return res.status(404).json({ message: "Report not found" });

    const [enriched] = await enrichReportsWithTargets(prisma, [report]);   // enrich report with targets (Helper)
    res.json(enriched);                               // respond with the report
  } catch (err) { next(err); }                        // catch errors and pass to error handler
}



// ---------------- UPDATE REPORT (Admin action) ----------------
export async function adminUpdateReport(req, res, next) {
  try {
    const { id } = req.params;                        // get report id from params
    const { status, resolutionNote } = req.body;      // get status and resolutionNote from request body

    // Verify the report exists, if not found return 404
    const existing = await prisma.report.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!existing) return res.status(404).json({ message: "Report not found" });

    // Guard: can't re-review an already resolved report (prevents accidental overrides)
    if (existing.status !== "PENDING") {
      return res.status(400).json({
        message: `This report is already ${existing.status.toLowerCase()}. Cannot update.`,
      });
    }

    // Update the report
    const updated = await prisma.report.update({
      where: { id },
      data: { status, resolutionNote: resolutionNote || null, reviewedById: req.user.id,  reviewedAt: new Date() },
      include: {
        reporter: { select: { id: true, name: true, email: true, image: true } },
        reviewedBy: { select: { id: true, name: true } },
      },
    });

    res.json(updated);                        // respond with the updated report
  } catch (err) { next(err); }                // catch errors and pass to error handler
}



// ---------------- Dashboard Home ----------------

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Aggregate daily counts for a Mongo collection within a date range.
// Returns [{ date: "YYYY-MM-DD", count: N }, ...] sorted oldest → newest.
// Days with zero activity are NOT included — the caller fills gaps.
async function aggregateDailyCounts(collectionName, since) {
  const result = await prisma.$runCommandRaw({
    aggregate: collectionName,
    pipeline: [
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { date: '$_id', count: 1, _id: 0 } },
    ],
    cursor: {},
  });
  return result.cursor.firstBatch ?? [];
}

// Fill in missing days with count 0 so the chart renders a continuous line.
function fillMissingDays(series, days) {
  const map = new Map(series.map((d) => [d.date, d.count]));
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, count: map.get(key) ?? 0 });
  }
  return out;
}



// ─── Controllers ───────────────────────────────────────────────────────────────

// ---------------- OVERVIEW ----------------
export async function adminStatsOverview(req, res, next) {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      usersTotal, usersNew, usersBanned,
      postsTotal, postsNew,
      commentsTotal, commentsNew,
      reportsPending, reportsActioned,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.user.count({ where: { bannedAt: { not: null } } }),
      prisma.post.count(),
      prisma.post.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.comment.count(),
      prisma.comment.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.report.count({ where: { status: 'PENDING' } }),
      prisma.report.count({ where: { status: 'ACTIONED' } }),
    ]);

    res.json({
      users:    { total: usersTotal, newThisWeek: usersNew, banned: usersBanned },
      posts:    { total: postsTotal, newThisWeek: postsNew },
      comments: { total: commentsTotal, newThisWeek: commentsNew },
      reports:  { pending: reportsPending, actioned: reportsActioned },
    });
  } catch (err) { next(err); }
}


// ---------------- TIMESERIES ----------------
// Daily counts for users, posts, and comments over a range (?range=7d|30d|90d).
export async function adminStatsTimeseries(req, res, next) {
  try {
    const range = req.query.range || '30d';
    const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [users, posts, comments] = await Promise.all([
      aggregateDailyCounts('User', since),
      aggregateDailyCounts('Post', since),
      aggregateDailyCounts('Comment', since),
    ]);

    res.json({
      range: `${days}d`,
      users:    fillMissingDays(users, days),
      posts:    fillMissingDays(posts, days),
      comments: fillMissingDays(comments, days),
    });
  } catch (err) { next(err); }
}


// ---------------- REPORTS BREAKDOWN ----------------
// Total reports grouped by reason, sorted by count desc.
export async function adminStatsReportsBreakdown(req, res, next) {
  try {
    const result = await prisma.$runCommandRaw({
      aggregate: 'Report',
      pipeline: [
        { $group: { _id: '$reason', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $project: { reason: '$_id', count: 1, _id: 0 } },
      ],
      cursor: {},
    });
    res.json({ reasons: result.cursor.firstBatch ?? [] });
  } catch (err) { next(err); }
}



// ---------------- RECENT ACTIVITY (mixed feed) ----------------
// Merges the last N users, posts, and reports into a single time-sorted list.
// Each item carries a `type` so the frontend can render type-specific copy.
export async function adminStatsRecentActivity(req, res, next) {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 15));  // limit max to 50
    // get the last N users, posts, and reports
    const [users, posts, reports] = await Promise.all([
      prisma.user.findMany({
        take: limit,
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, image: true, email: true, createdAt: true },
      }),
      prisma.post.findMany({
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true, title: true, createdAt: true,
          author: { select: { id: true, name: true, image: true } },
        },
      }),
      prisma.report.findMany({
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true, targetType: true, reason: true, status: true, createdAt: true,
          reporter: { select: { id: true, name: true, image: true } },
        },
      }),
    ]);
    // merge into a single list
    const items = [
      ...users.map((u) => ({
        id: `user-${u.id}`,
        type: "USER_SIGNUP",
        createdAt: u.createdAt,
        actor: { id: u.id, name: u.name, image: u.image },
        meta: { email: u.email },
      })),
      ...posts.map((p) => ({
        id: `post-${p.id}`,
        type: "POST_CREATED",
        createdAt: p.createdAt,
        actor: p.author,
        meta: { postId: p.id, title: p.title },
      })),
      ...reports.map((r) => ({
        id: `report-${r.id}`,
        type: "REPORT_CREATED",
        createdAt: r.createdAt,
        actor: r.reporter,
        meta: { reportId: r.id, targetType: r.targetType, reason: r.reason, status: r.status },
      })),
    ];

    // Sort merged list newest → oldest, cap to limit.
    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json({ activities: items.slice(0, limit) });      // return first N
  } catch (err) { next(err); }                            // catch errors and pass to error handler
}