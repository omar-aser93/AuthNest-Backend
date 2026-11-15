import { Expo } from 'expo-server-sdk';
import { prisma } from '../prisma.js';

export const expo = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN });

// ticketId → { token, sentAt }. Expires at 24h (see reaper).
const pendingTickets = new Map();

// ─── 1. Send push to every device of a user ───────────────────────────────
export async function sendPushToUser(userId, { title, body, data = {} }) {
  const rows = await prisma.pushToken.findMany({ where: { userId }, select: { token: true } });
  if (rows.length === 0) return;

  const messages = rows
    .filter(r => Expo.isExpoPushToken(r.token))       // validates format — accepts both ExponentPushToken[...] and ExpoPushToken[...]
    .map(r => ({
      to: r.token,
      sound: 'default',
      title,
      body,
      data,
      priority: 'high',
      channelId: 'default',                            // must match the channel the app creates
    }));
  if (messages.length === 0) return;

  // Expo caps each request at 100 messages — chunkPushNotifications handles that.
  for (const chunk of expo.chunkPushNotifications(messages)) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((t, i) => {
        if (t.status === 'ok' && t.id) {
          pendingTickets.set(t.id, { token: chunk[i].to, sentAt: Date.now() });
        } else if (t.status === 'error') {
          console.warn('[push] ticket error:', t.message, t.details);
          if (t.details?.error === 'DeviceNotRegistered') {
            prisma.pushToken.deleteMany({ where: { token: chunk[i].to } }).catch(() => {});
          }
        }
      });
    } catch (err) {
      console.error('[push] send chunk failed:', err.message);
    }
  }
}

// ─── 2. Receipt reaper — the piece first-timers forget ─────────────────────
export async function reapPushReceipts() {
  const now = Date.now();
  const ready = [];
  const STALE = 24 * 60 * 60 * 1000;

  for (const [id, meta] of pendingTickets) {
    const age = now - meta.sentAt;
    if (age > STALE) { pendingTickets.delete(id); continue; }   // receipt never came — drop
    if (age > 2 * 60 * 1000) ready.push(id);                    // old enough to check
  }
  if (ready.length === 0) return;

  for (const chunk of expo.chunkPushNotificationReceiptIds(ready)) {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(chunk);
      for (const [ticketId, r] of Object.entries(receipts)) {
        const meta = pendingTickets.get(ticketId);
        if (!meta) continue;
        if (r.status === 'error' && r.details?.error === 'DeviceNotRegistered') {
          await prisma.pushToken.deleteMany({ where: { token: meta.token } });
        }
        pendingTickets.delete(ticketId);
      }
    } catch (err) {
      console.error('[push] receipt fetch failed:', err.message);
    }
  }
}

export function startPushReceiptReaper() {
  setInterval(reapPushReceipts, 5 * 60 * 1000).unref?.();
}

// ─── 3. Is this user currently viewing this conversation? ──────────────────
// Uses socket.data.viewing, set explicitly by the client via `viewing_conversation`
// events. NOT room membership — every socket joins every conversation room on connect,
// so room membership does NOT indicate "currently viewing."
async function isUserViewingConversation(io, userId, conversationId) {
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  return sockets.some(s => s.data.viewing === conversationId);
}

// ─── 4. Chat push — shared by socket + REST paths ──────────────────────────
export async function sendChatPushToConversation(io, conversationId, senderId, senderName, preview) {
  try {
    const participants = await prisma.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });

    for (const { userId } of participants) {
      if (userId === senderId) continue;
      if (await isUserViewingConversation(io, userId, conversationId)) continue;

      sendPushToUser(userId, {
        title: senderName,
        body: preview,
        data: { url: `/messages/${conversationId}` },
      }).catch(err => console.error('[push] chat send failed:', err.message));
    }
  } catch (err) {
    console.error('[push] chat push coordinator failed:', err.message);
  }
}