// Enriches a list of reports with target previews.
// Because targetId is polymorphic, we batch-fetch targets by type and merge.
// Missing targets (deleted content) come back as { type, id, deleted: true }.
export async function enrichReportsWithTargets(prisma, reports) {
  if (reports.length === 0) return reports;

  const postIds    = reports.filter(r => r.targetType === "POST").map(r => r.targetId);
  const commentIds = reports.filter(r => r.targetType === "COMMENT").map(r => r.targetId);
  const userIds    = reports.filter(r => r.targetType === "USER").map(r => r.targetId);

  const [posts, comments, users] = await Promise.all([
    postIds.length > 0
      ? prisma.post.findMany({
          where: { id: { in: postIds } },
          select: {
            id: true, title: true, content: true, image: true, privacy: true,
            author: { select: { id: true, name: true, image: true } },
          },
        })
      : Promise.resolve([]),

    commentIds.length > 0
      ? prisma.comment.findMany({
          where: { id: { in: commentIds } },
          select: {
            id: true, content: true, postId: true,
            user: { select: { id: true, name: true, image: true } },
          },
        })
      : Promise.resolve([]),

    userIds.length > 0
      ? prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true, image: true, role: true },
        })
      : Promise.resolve([]),
  ]);

  const postMap    = new Map(posts.map(p => [p.id, p]));
  const commentMap = new Map(comments.map(c => [c.id, c]));
  const userMap    = new Map(users.map(u => [u.id, u]));

  return reports.map(report => {
    let target = null;

    if (report.targetType === "POST") {
      const p = postMap.get(report.targetId);
      target = p
        ? { type: "POST", id: p.id, title: p.title, contentExcerpt: p.content?.slice(0, 200) ?? null, image: p.image, privacy: p.privacy, author: p.author }
        : { type: "POST", id: report.targetId, deleted: true };
    } else if (report.targetType === "COMMENT") {
      const c = commentMap.get(report.targetId);
      target = c
        ? { type: "COMMENT", id: c.id, contentExcerpt: c.content?.slice(0, 200) ?? null, postId: c.postId, user: c.user }
        : { type: "COMMENT", id: report.targetId, deleted: true };
    } else if (report.targetType === "USER") {
      const u = userMap.get(report.targetId);
      target = u
        ? { type: "USER", id: u.id, name: u.name, email: u.email, image: u.image, role: u.role }
        : { type: "USER", id: report.targetId, deleted: true };
    }

    return { ...report, target };
  });
}