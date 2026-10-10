// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE REACTIONS SUMMARY UTILITY
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from '../prisma.js';


// Shared helper — recalculates summary from all current reactions and persists it
// Called after every add/update/remove so the stored summary is always in sync
export async function recalculateMessageSummary(messageId) {
  const allReactions = await prisma.messageReaction.findMany({ where: { messageId } });
  const summary = allReactions.reduce((acc, r) => {
    acc[r.type] = (acc[r.type] || 0) + 1;
    return acc;
  }, {});
  await prisma.message.update({
    where: { id: messageId },
    data: { reactionCount: allReactions.length, reactionSummary: summary },
  });
  return { summary, count: allReactions.length };
}
