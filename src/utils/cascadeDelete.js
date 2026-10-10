// Because MongoDB doesn't support cascade delete with prisma (unlike Postgres), we have to do it ourselves.


// Walk replies recursively and return the full set of comment IDs.
export async function collectCommentDescendants(tx, rootIds) {
  const all = [...rootIds];
  let frontier = rootIds;
  while (frontier.length > 0) {
    const replies = await tx.comment.findMany({
      where: { parentId: { in: frontier } },
      select: { id: true },
    });
    const fresh = replies.map((r) => r.id).filter((id) => !all.includes(id));
    if (fresh.length === 0) break;
    all.push(...fresh);
    frontier = fresh;
  }
  return all;
}


// Soft Delete reports pointing at specific targets (posts, comments, users).
export async function deleteReportsForTargets(tx, targetType, targetIds) {
  if (targetIds.length === 0) return;
  await tx.report.updateMany({
    where: { targetType, targetId: { in: targetIds }, status: "PENDING" },
    data: { status: "ACTIONED", resolutionNote: "Content deleted", reviewedAt: new Date(), },
  });
}


// Delete comments + all replies + their children (notifications, reactions, tags, editHistory).
// Does NOT delete the parent post — caller handles that.
export async function deleteCommentsCascade(tx, commentIds) {
  if (commentIds.length === 0) return;
  const all = await collectCommentDescendants(tx, commentIds);

  await deleteReportsForTargets(tx, "COMMENT", all);  // Delete reports

  // Comment-level children
  await tx.notification.deleteMany({ where: { commentId: { in: all } } });
  await tx.commentReaction.deleteMany({ where: { commentId: { in: all } } });
  await tx.tag.deleteMany({ where: { commentId: { in: all } } });
  await tx.editHistory.deleteMany({ where: { commentId: { in: all } } });
  await tx.comment.deleteMany({ where: { id: { in: all } } });
}


// Delete posts + all related data (comments with replies, reactions, shares, saved, tags, editHistory, notifications).
// Nulls originalPostId on shares so the shared wrapper posts survive.
export async function deletePostsCascade(tx, postIds) {
  if (postIds.length === 0) return;

  // Comments on these posts (and their replies) via the helper above
  const comments = await tx.comment.findMany({ where: { postId: { in: postIds } }, select: { id: true }, });
  await deleteCommentsCascade(tx, comments.map((c) => c.id));

  await deleteReportsForTargets(tx, "POST", postIds);    // Delete reports

  // Post-level children
  await tx.reaction.deleteMany({ where: { postId: { in: postIds } } });
  await tx.share.deleteMany({ where: { postId: { in: postIds } } });
  await tx.savedPost.deleteMany({ where: { postId: { in: postIds } } });
  await tx.tag.deleteMany({ where: { postId: { in: postIds } } });
  await tx.editHistory.deleteMany({ where: { postId: { in: postIds } } });
  await tx.notification.deleteMany({ where: { postId: { in: postIds } } });

  // Preserve shares by nulling originalPostId
  await tx.post.updateMany({
    where: { originalPostId: { in: postIds } },
    data: { originalPostId: null },
  });

  await tx.post.deleteMany({ where: { id: { in: postIds } } });
}


// Delete messages + children (attachments, reads, reactions, tags, editHistory).
// Pass deleteCloudinaryFn to also clean up Cloudinary assets. Pass null to skip.
export async function deleteMessagesCascade(tx, messageIds, deleteCloudinaryFn = null) {
  if (messageIds.length === 0) return;

  if (deleteCloudinaryFn) {
    const attachments = await tx.messageAttachment.findMany({
      where: { messageId: { in: messageIds }, publicId: { not: "" } },
      select: { publicId: true },
    });
    for (const att of attachments) await deleteCloudinaryFn(att.publicId);
  }

  await tx.messageAttachment.deleteMany({ where: { messageId: { in: messageIds } } });
  await tx.messageRead.deleteMany({ where: { messageId: { in: messageIds } } });
  await tx.messageReaction.deleteMany({ where: { messageId: { in: messageIds } } });
  await tx.tag.deleteMany({ where: { messageId: { in: messageIds } } });
  await tx.editHistory.deleteMany({ where: { messageId: { in: messageIds } } });
  await tx.message.deleteMany({ where: { id: { in: messageIds } } });
}


// Delete calls + all participants.
export async function deleteCallsCascade(tx, callIds) {
  if (callIds.length === 0) return;
  await tx.callParticipant.deleteMany({ where: { callId: { in: callIds } } });
  await tx.call.deleteMany({ where: { id: { in: callIds } } });
}


// Delete conversations: messages + calls + participants + the conversation.
export async function deleteConversationsCascade(tx, conversationIds, deleteCloudinaryFn = null) {
  if (conversationIds.length === 0) return;

  const messages = await tx.message.findMany({ where: { conversationId: { in: conversationIds } }, select: { id: true } });
  await deleteMessagesCascade(tx, messages.map((m) => m.id), deleteCloudinaryFn);

  const calls = await tx.call.findMany({ where: { conversationId: { in: conversationIds } }, select: { id: true } });
  await deleteCallsCascade(tx, calls.map((c) => c.id));

  await tx.conversationParticipant.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await tx.conversation.deleteMany({ where: { id: { in: conversationIds } } });
}