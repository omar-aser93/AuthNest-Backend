import admin from 'firebase-admin';
import { randomUUID } from 'crypto';
import { prisma } from '../prisma.js';

// ─── Lazy Firebase init (call pushes are disabled, not crashing, if the env var is missing) ──
let messagingInstance = null;
let initTried = false;

function getMessaging() {
  if (initTried) return messagingInstance;
  initTried = true;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) {
    console.warn('[call-push] FIREBASE_SERVICE_ACCOUNT_B64 missing — call pushes disabled');
    return null;
  }
  try {
    const sa = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
    messagingInstance = admin.messaging();
  } catch (err) {
    console.error('[call-push] Firebase init failed:', err.message);
  }
  return messagingInstance;
}

// ─── Send one data message to every FCM token of a user; returns how many tokens were tried ──
async function sendToUserDevices(userId, data) {
  const messaging = getMessaging();
  if (!messaging) return 0;

  const rows = await prisma.voipToken.findMany({ where: { userId, type: 'FCM' }, select: { token: true } });
  let sent = 0;

  await Promise.all(rows.map(async ({ token }) => {
    try {
      await messaging.send({ token, data, android: { priority: 'high', ttl: 30_000 } });
      sent++;
    } catch (err) {
      const code = err?.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        await prisma.voipToken.deleteMany({ where: { token } }).catch(() => {});
      } else {
        console.error('[call-push] send failed:', code, err?.message);
      }
    }
  }));

  return sent;
}

// ─── Ring the callee's phone ─────────────────────────────────────────────────
export function sendIncomingCallPush(calleeId, { callId, conversationId, callerId, callerName, callerImage, callType }) {
  return sendToUserDevices(calleeId, {
    messageType: 'incomingCall',
    incomingCall: JSON.stringify({
      eventId: randomUUID(),
      serverCallId: callId,
      hasVideo: callType === 'video',
      startedAt: new Date().toISOString(),
      caller: { id: callerId, displayName: callerName, ...(callerImage && { avatarUrl: callerImage }) },
      metadata: { conversationId },
    }),
  });
}

// ─── Stop the callee's phone ringing (caller cancelled / timed out) ──────────
export function sendCallEndedPush(userId, { callId, reason = 'remoteEnded' }) {
  return sendToUserDevices(userId, {
    messageType: 'callEnded',
    callEnded: JSON.stringify({ eventId: randomUUID(), serverCallId: callId, reason }),
  });
}