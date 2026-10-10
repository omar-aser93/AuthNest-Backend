import { prisma } from '../prisma.js';

const DAILY_LIMIT = 10;   // max reports per user per 24h


// ---------------- CREATE REPORT ----------------
export async function createReport(req, res, next) {
  try {
    const reporterId = req.user.id;                                    // get user id from token
    const { targetType, targetId, reason, description } = req.body;    // get report details

    // ── 1. Verify target exists + prevent self-report ──────────────────────
    let targetAuthorId = null;
    if (targetType === "POST") {
      const post = await prisma.post.findUnique({ where: { id: targetId }, select: { authorId: true } });
      if (!post) return res.status(404).json({ message: "Post not found" });
      targetAuthorId = post.authorId;
    } else if (targetType === "COMMENT") {
      const comment = await prisma.comment.findUnique({ where: { id: targetId }, select: { userId: true } });
      if (!comment) return res.status(404).json({ message: "Comment not found" });
      targetAuthorId = comment.userId;
    } else if (targetType === "USER") {
      const user = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
      if (!user) return res.status(404).json({ message: "User not found" });
      targetAuthorId = user.id;
    }

    if (targetAuthorId === reporterId) {
      return res.status(400).json({ message: "You cannot report your own content" });
    }

    // ── 2. Daily rate limit ────────────────────────────────────────────────
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentCount = await prisma.report.count({
      where: { reporterId, createdAt: { gte: since } },
    });
    if (recentCount >= DAILY_LIMIT) {
      return res.status(429).json({
        message: `You've reached the daily limit of ${DAILY_LIMIT} reports. Try again tomorrow.`,
      });
    }

    // ── 3. Create (unique constraint catches duplicates) ──────────────────
    const report = await prisma.report.create({
      data: { targetType, targetId, reason, description: description || null, reporterId },
      select: {
        id: true, targetType: true, targetId: true,
        reason: true, status: true, createdAt: true,
      },
    });

    res.status(201).json({ report });
  } catch (err) {
    // Prisma P2002 = unique constraint violation (duplicate report)
    if (err.code === 'P2002') {
      return res.status(409).json({ message: "You already reported this" });
    }
    next(err);          // catch errors and pass to error handler
  }
}



// ---------------- GET MY REPORTS ----------------
export async function getMyReports(req, res, next) {
  try {
    const reporterId = req.user.id;                                            // get user id from token
    const page = Math.max(1, parseInt(req.query.page) || 1);                   // simple offset pagination
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));  // limit max to 50

    // ── Fetch reports ─────────────────────────────────────────────────
    const [reports, total] = await Promise.all([
      prisma.report.findMany({
        where: { reporterId },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true, targetType: true, targetId: true,
          reason: true, status: true, createdAt: true,
          reviewedAt: true,
          // reporter doesn't see reviewer identity or resolutionNote
        },
      }),
      prisma.report.count({ where: { reporterId } }),
    ]);

    // respond with reports, total, page, limit, and totalPages
    res.json({ reports, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) { next(err); }            // catch errors and pass to error handler
}