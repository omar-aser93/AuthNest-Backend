import crypto from 'crypto';
import { prisma } from '../prisma.js';
import { hashToken } from './hash.js';
import { createAccessToken, createRefreshToken } from './token.js';

// ─────────────────────────────────────────────────────────────────────────────
// SESSION HELPERS
// - Central place for "how does a login become a session." Every auth entry point — signup, login, both OAuth flows, adminLogin — calls createSession() rather than minting tokens manually.
// - One DB write per login. We generate the sessionId (UUID) in memory so the refresh token can carry it in the `sid` claim BEFORE the row exists. No placeholder, no follow-up update.
// ─────────────────────────────────────────────────────────────────────────────

export async function createSession({ userId, role, remember = false, req }) {
  // Refresh token expiry, change based on remember-me   
  const refreshExpiryDays = remember ? 30 : 7;
  const expiresAt = new Date(Date.now() + refreshExpiryDays * 24 * 60 * 60 * 1000);
  // UUID, decoupled from the Prisma _id.
  const sessionId = crypto.randomUUID();
  // Access token — carries role. This is what auth middleware reads.
  const accessToken = createAccessToken({ sub: userId, role });
  // Refresh token — carries sessionId + remember. NOT role (Endpoint reads the current role from the DB, so role changes take effect on the next refresh without a forced logout).
  const refreshToken = createRefreshToken({ sub: userId, sid: sessionId, remember }, `${refreshExpiryDays}d`);
  const refreshTokenHash = hashToken(refreshToken);       // hash the refresh token
  // Write the session
  await prisma.session.create({
    data: { sessionId, userId, refreshTokenHash, expiresAt, userAgent: req?.headers?.['user-agent']?.slice(0, 200) ?? null, ipAddress: req?.ip ?? null },
  });
  // return the tokens
  return { accessToken, refreshToken, remember, refreshExpiryDays, sessionId };
}


// Used by adminLogin AND refreshToken — Returns the CSRF token so callers that need it in the JSON body can use it
// (the refresh endpoint does — Next.js proxy.ts reads it from the response).
// adminLogin ignores the return; the cookie is enough for the admin SPA.
export function setAuthCookies(res, { accessToken, refreshToken, refreshExpiryDays }) {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieOptions = { httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax', path: '/' };
  res.cookie('accessToken', accessToken, { ...cookieOptions, maxAge: 15 * 60 * 1000 });
  res.cookie('refreshToken', refreshToken, { ...cookieOptions, maxAge: refreshExpiryDays * 24 * 60 * 60 * 1000 });
  const csrfToken = crypto.randomBytes(32).toString('hex');
  res.cookie('csrfToken', csrfToken, { ...cookieOptions, httpOnly: false, maxAge: 30 * 24 * 60 * 60 * 1000 });
  return csrfToken;
}


// Clears all auth cookies - Cookie options must match what res.cookie used, or the browser silently ignores the deletion.
export function clearAuthCookies(res) {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieOptions = { path: '/', secure: isProd, sameSite: isProd ? 'none' : 'lax' };
  res.clearCookie('accessToken', cookieOptions);
  res.clearCookie('refreshToken', cookieOptions);
  res.clearCookie('csrfToken', { ...cookieOptions, httpOnly: false });
}



// --------------------- NOTE ---------------------
// SESSION LIFETIME: absolute — expires N days after login, regardless of activity.
// Refresh rotates the token but does NOT extend session.expiresAt.
// To switch to sliding sessions (incremental everytime), update expiresAt inside refreshToken's updateMany.