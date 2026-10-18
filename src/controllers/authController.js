import { hashItem, compareHashed, hashToken, compareTokens } from '../utils/hash.js';
import { createAccessToken, createRefreshToken, verifyRefreshToken } from '../utils/token.js';
import { sendEmail } from '../utils/email.js';
import { escapeHtml } from '../utils/XSS-sanitization.js';
import { getIO } from '../socket/index.js';
import { clearAuthCookies, createSession, setAuthCookies } from '../utils/sessionHelper.js';
import crypto from 'crypto';
import { prisma } from '../prisma.js';
import { OAuth2Client } from "google-auth-library";

const REFRESH_COOKIE_NAME = 'refreshToken';    // name of refresh token cookie


// ----------------  SIGNUP CONTROLLER ----------------
export async function signup(req, res, next) {
  try {
    // extract fields, if no email or password, return 400 "required"
    const { name, email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });
    
    // check if email already exists in db, if yes return 400 "email already exists"
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ message: 'Email already exists' });
   
    // hash the password and create email-verify token
    const hashed = await hashItem(password);  
    const emailToken = crypto.randomUUID(); 
    const emailVerifyToken= await hashItem(emailToken);
    // create user in DB, with (name, email, hashed-password, isEmailVerified false, emailVerifyToken and emailVerifyExpiry)
    const user = await prisma.user.create({ data: { name, email, password: hashed, isEmailVerified: false, emailVerifyToken, emailVerifyExpiry: new Date(Date.now() + 1000 * 60 * 60 * 24)} }); 
    
    // Send verification email, with link containing unique emailToken as query param
    try { 
    await sendEmail({
      to: email,
      subject: "Verify Your Email",
      html: `<p>Hello ${escapeHtml(name)},</p>
             <p>Please verify your email by clicking the link: </p>
             <a href="${process.env.FRONTEND_ORIGIN}/verify-email?token=${emailToken}&email=${encodeURIComponent(email)}">
               Verify Email
             </a> <br>
             <p>Expires in 24 hours</p>`,
    }) } catch (err) { console.log('Sending email failed:', err); }

    // create session - using the helper function
    const { accessToken, refreshToken } = await createSession({ userId: user.id, role: user.role, remember: false, req });  
      
    // respond with user info and the tokens
    res.status(201).json({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, accessToken, refreshToken });
  } catch (err) { next(err); }  // catch errors and pass to error handler
}



// ----------------  LOGIN CONTROLLER ----------------
export async function login(req, res, next) {
  try {
    // extract (email, password and remember-me flag) from req.body
    const { email, password, remember } = req.body;
    // find user by email, if not found return 401 "invalid credentials"
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });

    // If user was created via social login (no password), disallow password login
    if (!user.password) { return res.status(403).json({ message: 'Account registered via social login. Use social sign-in.' }); }

    // compare password with hashed password, if not match return 401 "invalid credentials"
    const ok = await compareHashed(password, user.password);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

    // if user is banned by admin, return 403 "Your account has been suspended"
    if (user.bannedAt) return res.status(403).json({ message: 'Your account has been suspended' });

    // create session - using the helper function
    const { accessToken, refreshToken } = await createSession({ userId: user.id, role: user.role, remember: !!remember, req });
    
    // respond with user info, the tokens and remember-me flag
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, accessToken, refreshToken, remember });
  } catch (err) { next(err); }     // catch errors and pass to error handler
}



// ----------------  REFRESH TOKEN CONTROLLER ----------------
export async function refreshToken(req, res, next) {
  try {
    // read refresh token from both (headers, cookie), so it can work for either web browser or mobile app
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const cookieToken = req.cookies[REFRESH_COOKIE_NAME];

    // check if token is present, if not return 401 "No refresh token"
    const token = bearerToken || cookieToken;
    if (!token) return res.status(401).json({ message: 'No refresh token' });      

    // verify the refresh token... if it is invalid, return 403 "Invalid refresh token"
    let payload;
    try { payload = verifyRefreshToken(token); } 
    catch (err) { return res.status(403).json({ message: 'Invalid refresh token' }) }
    // if no sessionId is present in the payload, return 403 "Invalid refresh token"
    if (!payload.sid) return res.status(403).json({ message: 'Invalid refresh token' });

    // get session by sessionId (UUID), if not found return 403 "Session not found"
    const session = await prisma.session.findUnique({ where: { sessionId: payload.sid }, include: { user: true } });
    if (!session) return res.status(403).json({ message: 'Session not found' });

    // Hard cap — session lifetime, independent of the JWT's own `exp` claim.
    if (session.expiresAt <= new Date()) {
      await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
      return res.status(403).json({ message: 'Session expired, please login again' });
    }

    // Verify the incoming token against the stored hash.
    const valid = await compareTokens(token, session.refreshTokenHash);
    if (!valid) return res.status(403).json({ message: 'Invalid refresh token' });

    // Ban check — fail fast if the user was banned mid-session.
    if (session.user.bannedAt) {
      await prisma.session.deleteMany({ where: { userId: session.user.id } });
      return res.status(403).json({ message: 'Your account has been suspended' });
    }

    // ── Rotate the refresh token, Read role from the CURRENT DB row, not the token. This makes role changes take effect on next refresh without forcing a logout.
    const remember = !!payload.remember;
    const refreshExpiryDays = remember ? 30 : 7;
    const newAccessToken = createAccessToken({ sub: session.user.id, role: session.user.role });
    const newRefreshToken = createRefreshToken({ sub: session.user.id, sid: session.sessionId, remember }, `${refreshExpiryDays}d` );
    const newHashed = hashToken(newRefreshToken);

    // Atomic rotation guard — only rotate if the hash we read is still the DB hash.
    // Two concurrent refreshes can't both succeed.
    const updateResult = await prisma.session.updateMany({
      where: { id: session.id, refreshTokenHash: session.refreshTokenHash },
      data: { refreshTokenHash: newHashed, lastUsedAt: new Date() },
    });
    if (updateResult.count === 0) {
      return res.status(409).json({ message: 'Refresh token rotated by another request' });
    }

    // ── Set new cookies via the shared session helper ─────────────────────────────────
    const newCsrf = setAuthCookies(res, { accessToken: newAccessToken, refreshToken: newRefreshToken, refreshExpiryDays });
    
    // NOTE: tokens ARE returned in the JSON body on purpose. Browser-based clients ignore them (cookies are enough), but the Next.js proxy.ts runs on the server and calls this endpoint. 
    return res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken, csrfToken: newCsrf, refreshExpiryDays, });
  } catch (err) { next(err); }
}



// ----------------  LOGOUT CONTROLLER ----------------
export async function logout(req, res, next) {
  try {
    // Always clear cookies first — even if there's no token, stale cookies may still exist on the client
    clearAuthCookies(res);

    // read refresh token from both (headers, cookie), so it can work for either web browser or mobile app
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const cookieToken = req.cookies[REFRESH_COOKIE_NAME];

    // check if token is present, if no token → nothing to delete from the DB, cookies already cleared
    const token = bearerToken || cookieToken;
    if (!token) return res.json({ message: 'Logged out' });   

    // if refresh token present, verify it, then clear DB refresh token by user id
    if (token) {      
      try {
        const payload = verifyRefreshToken(token);
        if (payload.sid) {
          // Delete ONLY this session. Scoped by userId too, so a crafted sid can't delete another user's session.
          await prisma.session.deleteMany({ where: { sessionId: payload.sid, userId: payload.sub } });
          getIO()?.in(`user:${payload.sub}`).disconnectSockets(true);    // disconnect all sockets for this user
        }
      } catch { /* invalid/expired token — proceed to clear cookie anyway */ }
    }
    
    res.json({ message: 'Logged out' });      // return success message
  } catch (err) { next(err); }                // catch errors and pass to error handler
}



// ----------------  VERIFY EMAIL CONTROLLER ----------------
export async function verifyEmail(req, res, next) {
  try {
    // extract token and email from query params, trim & lowecase email... if missing return 400 "Invalid verification link"
    const { token, email: rawEmail } = req.query;
    const email = rawEmail?.trim().toLowerCase();
    if (!token || !email) return res.status(400).json({ message: "Invalid verification link" });
    // find user by email in db, if not found or no emailVerifyToken return 400 "Invalid or expired token"
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.emailVerifyToken) return res.status(400).json({ message: "Invalid or expired token" });

    // check expiry of emailVerifyToken, if expired return 400 "Token expired"
    if (user.emailVerifyExpiry < new Date()) return res.status(400).json({ message: "Token expired" });

    // compare token from query with hashed token in db, if not match return 400 "Invalid token"
    const valid = await compareHashed(token, user.emailVerifyToken);
    if (!valid) return res.status(400).json({ message: "Invalid token" });

    // update user in db, to mark verified and clear token
    await prisma.user.update({ where: { email }, data: { isEmailVerified: true, emailVerifyToken: null, emailVerifyExpiry: null } });

    return res.json({ message: "Email verified successfully" });    // respond with success
  } catch (err) { next(err); }                      // catch errors and pass to error handler
}



// ---------------- RESEND VERIFICATION CONTROLLER ---------------- 
export async function resendVerification(req, res, next) {
  try {
    // find user by id from req.user (set in auth middleware by decoding the token)
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    
    // if user not found, return 404 "User not found", if already verified return 400 "Email already verified"
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.isEmailVerified) return res.status(400).json({ message: "Email already verified" });
    
    // generate new email verify-token and expiry & store theem in db
    const emailToken = crypto.randomUUID(); 
    const emailVerifyToken= await hashItem(emailToken);
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifyToken, emailVerifyExpiry: new Date(Date.now() + 1000 * 60 * 60 * 24)} });

    // Send verification email, with link containing unique emailToken as query param
    try { 
    await sendEmail({
      to: user.email,
      subject: "Verify Your Email",
      html: `<p>Hello ${escapeHtml(user.name)},</p>
             <p>Please verify your email by clicking the link: </p>
             <a href="${process.env.FRONTEND_ORIGIN}/verify-email?token=${emailToken}&email=${encodeURIComponent(user.email)}">
               Verify Email
             </a> <br>
             <p>Expires in 24 hours</p>`,
    }) } catch (err) { console.log('Sending email failed:', err); }

    res.json({ message: "Verification email sent" });     // respond with success
  } catch (err) { next(err); }                            // catch errors and pass to error handler
}



// ---------------- FORGOT PASSWORD CONTROLLER ----------------
export const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;             // get email from request body
    
    // Find user by email in db, if not found return 404 "User not found"
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ message: "User not found" });

    // If user registered via social login (no password), they can't reset a password
    if (!user.password) {
      // Tell them which providers they can use to sign in
      const providers = [ user.googleId ? "Google" : null, user.githubId ? "GitHub" : null ].filter(Boolean).join(" or ");
      return res.status(400).json({ message: `This account uses ${providers || "social"} sign-in. No password to reset.` });
    }

    // Generate 6-digit OTP
    const otp = String(crypto.randomInt(100000, 1000000)); 
    // Hash OTP before storing
    const hashedOtp = await hashItem(otp);
    // Store hashed OTP and expiry (10 minutes from now) in db
    await prisma.user.update({ where: { email }, data: { resetOtp: hashedOtp, resetOtpExpiry: new Date(Date.now() + 1000 * 60 * 10), resetOtpAttempts: 0 }});

    // Send OTP email
    await sendEmail({
      to: user.email,
      subject: "Your Password Reset Code",
      html: `
        <p>Hello ${escapeHtml(user.name || "")},</p>
        <p>Your password reset code is:</p>
        <h2 style="font-size: 32px; letter-spacing: 2px;">${otp}</h2>
        <p>This code expires in 10 minutes.</p>
      `,
    });

    return res.json({ message: "OTP sent to your email" });     // respond with success
  } catch (err) { next(err); }                                  // catch errors and pass to error handler
};



// ---------------- VERIFY OTP CONTROLLER ----------------
export const verifyOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;                 // extract email and otp from request body
    
    // Find user by email in db, if not found or no otp stored return 400 "Invalid request"
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.resetOtp) return res.status(400).json({ message: "Invalid request" });

    // Check expiry, if expired return 400 "OTP expired"
    if (user.resetOtpExpiry < new Date()) { return res.status(400).json({ message: "OTP expired" }); }

    // Verify OTP, Increment attempts & invalidate if attempts > 5, then compare with hashed otp in db
    const { resetOtpAttempts } = await prisma.user.update({ where: { id: user.id }, data: { resetOtpAttempts: { increment: 1 } }, select: { resetOtpAttempts: true } });
    if (resetOtpAttempts > 5) {
      // Invalidate the OTP. Do NOT reset attempts to 0 here — a parallel request that read resetOtp before we nulled it could still match without hitting this branch.
      await prisma.user.update({ where: { id: user.id }, data: { resetOtp: null, resetOtpExpiry: null } });
      return res.status(400).json({ message: "Too many incorrect attempts. Request a new code." });
    }
    const isMatch = await compareHashed(otp, user.resetOtp);                  // compare received otp with the hashed otp in DB
    if (!isMatch) return res.status(400).json({ message: "Incorrect OTP" });  // if not match return 400 "Incorrect OTP"

    // OTP is valid → create a reset token (used in resetPassword step for security, in case user skipped verifyOtp step & went to resetPassword directly)
    const resetToken = crypto.randomUUID();
    const hashedResetToken = await hashItem(resetToken);
    // Store resetToken and its expiry (10 minutes from now) in db, also clear resetOtp and resetOtpExpiry (so OTP can't be reused) & clear the resetOtpAttempts
    await prisma.user.update({ where: { email }, data: { resetToken: hashedResetToken, resetTokenExpiry: new Date(Date.now() + 10 * 60 * 1000), resetOtp: null, resetOtpExpiry: null, resetOtpAttempts: 0 } });

    return res.json({ message: "OTP verified successfully", resetToken });    // respond with success & actual resetToken
  } catch (err) { next(err); }        // catch errors and pass to error handler
};



// ---------------- RESET PASSWORD CONTROLLER ----------------
export const resetPassword = async (req, res, next) => {
  try {    
    const { email, newPassword, resetToken } = req.body;    // extract email, newPassword and resetToken from request body       

    // Find user by email in db, if not found or no resetToken stored return 400 "Invalid or expired reset token"
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.resetToken || !user.resetTokenExpiry) { return res.status(400).json({ message: "Invalid or expired reset token" }); }
    
    // Check received resetToken-expiry, if expired return 400 "Reset token expired"
    if (user.resetTokenExpiry < new Date()) { return res.status(400).json({ message: "Reset token expired" }); }
    // Verify & Compare provided plain reset token with hashed value in DB, if not match return 400 "Invalid reset token"
    const tokenMatch = await compareHashed(resetToken, user.resetToken);
    if (!tokenMatch) return res.status(400).json({ message: "Invalid reset token" });

    // Hash the new password and update in db, also clear resetToken and resetTokenExpiry & clear sessions
    const hashed = await hashItem(newPassword);     
    await prisma.user.update({ where: { email }, data: { password: hashed, resetToken: null, resetTokenExpiry: null }});
    await prisma.session.deleteMany({ where: { userId: user.id } });
    getIO()?.in(`user:${user.id}`).disconnectSockets(true);             // disconnect all sockets for this user

    return res.json({ message: "Password updated successfully" });      // respond with success
    } catch (err) { next(err); }         // catch errors and pass to error handler
};



// ---------------- OAUTH CONTROLLERS ----------------

// OAuth config from environment variables
const GOOGLE = { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, redirectUri: process.env.GOOGLE_REDIRECT_URI };
const GITHUB = { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET, redirectUri: process.env.GITHUB_REDIRECT_URI };

// ---------------- GOOGLE OAUTH CONTROLLER ----------------
export async function googleOAuth(req, res, next) {
  try {
    // 0. Get code from req.body, if no code return 400 "Code is required"
    const code = req.body.code;
    if (!code) return res.status(400).json({ message: "Code is required" });

    // 1. Exchange code for tokens after verifying using OAuth2Client (package helps verify ID tokens)
    const client = new OAuth2Client({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, redirectUri: process.env.GOOGLE_REDIRECT_URI });
    const { tokens } = await client.getToken(code);
    // Check if id_token is present, if not return 400 "No id_token returned"
    if (!tokens.id_token) return res.status(400).json({ message: "No id_token returned" });

    // 2. VERIFY id_token (signature, aud, exp, iss) & set the payload
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE.clientId});
    const payload = ticket.getPayload();
    // Extract email, email_verified, name, picture from payload
    const { email: rawEmail, email_verified, name, picture } = payload;
    const email = rawEmail.trim().toLowerCase();      // trim & lowercase email
    // Check if email is verified, if not return 403 "Email not verified" (allow only verified emails, for security)
    if (!email_verified) return res.status(403).json({ message: "Email not verified" });
   
    // 3. Check the user by email
    let user = await prisma.user.findUnique({ where: { email } }); 
    // If user not found, create a new user in db (with social login > password is null)  
    if (!user) { user = await prisma.user.create({ data: { email, name, image: picture, password: null, googleId: payload.sub, isEmailVerified: true } }); } 
    // if user is banned by admin, return 403 "Your account has been suspended"
    if (user.bannedAt) return res.status(403).json({ message: 'Your account has been suspended' });
    // If we find a user local account (email/password) with same email as Google OAuth, We can either block the OAuth login, or merge the accounts (We choose to merge & use Magic Link)
    else if (user.password && !user.googleId) {          
      const mergeToken = crypto.randomUUID();               // Generate a merge token (same pattern as emailVerifyToken)
      const hashedMergeToken = await hashItem(mergeToken);  // Hash the merge token      
      // Store in DB, the hashed merge token & the Google sub so we know what to link on confirmation
      await prisma.user.update({ where: { email }, data: { mergeToken: hashedMergeToken, mergeTokenExpiry: new Date(Date.now() + 1000 * 60 * 15), pendingGoogleId: payload.sub } });
      // Send verification email, with a magic link containing a unique mergeToken as query param
      try { 
      await sendEmail({
        to: email,
        subject: "Link your Google account",
        html: `
          <p>Someone tried to sign in with Google using this email.</p>
          <p>If this was you, click below to link your Google account:</p>
          <a href="${process.env.BACKEND_ORIGIN}/api/v1/auth/link-account?token=${mergeToken}&email=${encodeURIComponent(email)}"> Link Google Account </a>
          <p>Expires in 15 minutes. If this wasn't you, ignore this email.</p>
        `
      }) } catch (err) { console.log('Sending email failed:', err); }
      // Return a specific status so frontend knows to show "check your email" message
      return res.status(202).json({ message: "A verification email has been sent to link your Google account." });
    } 

    // if User exists and already-linked / or didn't exist but we just created, then we can create a session - using createSession helper function
    const { accessToken, refreshToken } = await createSession({ userId: user.id, role: user.role, remember: false, req });
   
    // respond with user info & the tokens
    return res.json({ user: { id: user.id, email, name, image: picture }, accessToken, refreshToken });     
  } catch (err) { next(err); }            // catch errors and pass to error handler
}



// ---------------- GITHUB OAUTH CONTROLLER ----------------
export async function githubOAuth(req, res, next) {
  try {
    // 0. Get code from req.body, if no code return 400 "Code is required"
    const code = req.body.code;
    if (!code) return res.status(400).json({ message: "Code is required" });

    // 1. Exchange code for access token
    const tokenRes = await fetch(`https://github.com/login/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        code,
        client_id: GITHUB.clientId,
        client_secret: GITHUB.clientSecret,
        redirect_uri: GITHUB.redirectUri,
      }),
    });
    // parse the res & Check if access_token is ok, if not return 400 "Failed to get GitHub access token"
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(400).json({ message: "Failed to get GitHub access token" });

    // 2. Get github user info 
    const profileRes = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    if (!profileRes.ok) return res.status(400).json({ message: "Failed to fetch GitHub profile" });
    const profile = await profileRes.json();

    // Get github emails, primary & verified
    const emailsRes = await fetch("https://api.github.com/user/emails", { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    const emails = await emailsRes.json();
    if (!Array.isArray(emails)) return res.status(400).json({ message: "Failed to fetch GitHub emails" });
    const primary = emails.find((e) => e.primary && e.verified);
    if (!primary) return res.status(403).json({ message: "No verified email found in GitHub account" });
    const email = primary.email.trim().toLowerCase();

    // 3. Check the user by email
    let user = await prisma.user.findUnique({ where: { email } });
    // If user not found, create a new user in db (with social login > password is null)
    if (!user) { user = await prisma.user.create({ data: { email, name: profile.name || profile.login, image: profile.avatar_url, password: null, githubId: String(profile.id), isEmailVerified: true } }); }
    // if user is banned by admin, return 403 "Your account has been suspended"
    if (user.bannedAt) return res.status(403).json({ message: 'Your account has been suspended' });
    // If we find a user local account (email/password) with same email as GitHub OAuth, We can either block the OAuth login, or merge the accounts (We choose to merge & use Magic Link)
    else if (user.password && !user.githubId) {
      const mergeToken = crypto.randomUUID();               // Generate a merge token (same pattern as emailVerifyToken)
      const hashedMergeToken = await hashItem(mergeToken);  // Hash the merge token   
      // Store in DB, the hashed merge token & the github sub so we know what to link on confirmation
      await prisma.user.update({ where: { id: user.id }, data: { mergeToken: hashedMergeToken, mergeTokenExpiry: new Date(Date.now() + 1000 * 60 * 15), pendingGithubId: String(profile.id) } });
      // Send verification email, with a magic link containing unique mergeToken as query param
      try { 
      await sendEmail({
        to: email,
        subject: "Link your GitHub account",
        html: `
          <p>Someone tried to sign in with GitHub using this email.</p>
          <p>If this was you, click below to link your GitHub account:</p>
          <a href="${process.env.BACKEND_ORIGIN}/api/v1/auth/link-account?token=${mergeToken}&email=${encodeURIComponent(email)}"> Link GitHub Account </a> 
          <p>Expires in 15 minutes. If this wasn't you, ignore this email.</p>
         `
      }) } catch (err) { console.log('Sending email failed:', err); }
      // Return a specific status so frontend knows to show "check your email" message
      return res.status(202).json({ message: "A verification email has been sent to link your GitHub account." });
    }

    // if User exists and already-linked / or didn't exist but we just created, then we can create a session - using createSession helper function
    const { accessToken, refreshToken } = await createSession({ userId: user.id, role: user.role, remember: false, req });

    // respond with user info & the tokens
    return res.json({ user: { id: user.id, email, name: profile.name || profile.login, image: profile.avatar_url }, accessToken, refreshToken });   
  } catch (err) { next(err); }         // catch errors and pass to error handler
}



// ---------------- CONFIRM MERGE ACCOUNT CONTROLLER ----------------
export async function confirmLinkAccount(req, res, next) {
  try {
    // Get token & email from query params, trim & lowercase email... if they are missing return 400 "Invalid link"
    const { token, email: rawEmail } = req.query;
    const email = rawEmail?.trim().toLowerCase();
    if (!token || !email) return res.status(400).json({ message: "Invalid link" });

    // Check if the token exists & not expired
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user?.mergeToken || !user?.mergeTokenExpiry) return res.status(400).json({ message: "Invalid or expired link" });
    if (user.mergeTokenExpiry < new Date()) return res.status(400).json({ message: "Link expired" });

    // if user is banned by admin, return 403 "Your account has been suspended"
    if (user.bannedAt) return res.status(403).json({ message: 'Your account has been suspended' });

    // Check if the token is valid by comparing it with the hashed token
    const valid = await compareHashed(token, user.mergeToken);
    if (!valid) return res.status(400).json({ message: "Invalid link" });

    // updateData variable is the common fields for all providers
    const updateData = { mergeToken: null, mergeTokenExpiry: null, isEmailVerified: true };
    if (!user.isEmailVerified) {
      // The account was never verified → assume it might belong to someone else. Clear the password so the OAuth provider becomes the only way in.
      updateData.password = null;
    }
    // Determine which provider to link based on which pending field exists
    if (user.pendingGoogleId) {
      updateData.googleId = user.pendingGoogleId;
      updateData.pendingGoogleId = null;
    } else if (user.pendingGithubId) {
      updateData.githubId = String(user.pendingGithubId);
      updateData.pendingGithubId = null;
    } else {
      return res.status(400).json({ message: "No pending account link found" });
    }
       
    // Update the user in db — link account, clear temp fields, verify email
    await prisma.user.update({ where: { email }, data: updateData });
    // always kill existing sessions on merge
    await prisma.session.deleteMany({ where: { userId: user.id } });

    // Log the user in by creating the session, using createSession helper function
    const { accessToken, refreshToken } = await createSession({ userId: user.id, role: user.role, remember: false, req });

    // Redirect to frontend with tokens as query params so the page can store them in cookies
    // (This is a GET request from the email link, not a fetch, so we can't set httpOnly cookies here directly)
    const redirectUrl = new URL(`${process.env.FRONTEND_ORIGIN}/api/callback/link-account`);
    redirectUrl.searchParams.set("accessToken", accessToken);         // set accessToken as query param
    redirectUrl.searchParams.set("refreshToken", refreshToken);       // set refreshToken as query param
    return res.redirect(redirectUrl.toString());                      // redirect to frontend

  } catch (err) { next(err); }            // catch errors and pass to error handler
}



// ---------------- GOOGLE OAUTH CONTROLLER (MOBILE — ID token) ----------------
// The native SDK signs the user in and returns an ID token directly. 
// It can't use the authorization-code flow from googleOAuth() in web controller above, 
// because the native app has different client IDs and redirect URIs. We verify the ID token here, then run the same create / ban / merge / session logic.
export async function googleMobileOAuth(req, res, next) {
  try {
    // Get idToken from req.body, if no idToken return 400 "idToken is required"
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ message: "idToken is required" });

    // Verify signature, exp, iss, and aud. The native SDK mints the token with the WEB client ID on every platform, so GOOGLE.clientId is the correct audience.
    const client = new OAuth2Client({ clientId: GOOGLE.clientId });
    let payload;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: GOOGLE.clientId });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({ message: "Invalid Google token" });
    }

    // Extract email, email_verified, name, picture from payload
    const { email: rawEmail, email_verified, name, picture, sub } = payload;
    const email = rawEmail?.trim().toLowerCase();
    if (!email) return res.status(400).json({ message: "Google account has no email" });
    if (!email_verified) return res.status(403).json({ message: "Email not verified" });

    // Check the user by email, if not found, create a new user
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: { email, name, image: picture, password: null, googleId: sub, isEmailVerified: true },
      });
    }
    if (user.bannedAt) return res.status(403).json({ message: "Your account has been suspended" });

    // Existing password account with the same email → merge flow (same as web).
    if (user.password && !user.googleId) {
      const mergeToken = crypto.randomUUID();
      const hashedMergeToken = await hashItem(mergeToken);
      await prisma.user.update({
        where: { email },
        data: {
          mergeToken: hashedMergeToken,
          mergeTokenExpiry: new Date(Date.now() + 1000 * 60 * 15),
          pendingGoogleId: sub,
        },
      });

      try {
        await sendEmail({
          to: email,
          subject: "Link your Google account",
          html: `
            <p>Someone tried to sign in with Google using this email.</p>
            <p>If this was you, click below to link your Google account:</p>
            <a href="${process.env.BACKEND_ORIGIN}/api/v1/auth/link-account?token=${mergeToken}&email=${encodeURIComponent(email)}"> Link Google Account </a>
            <p>Expires in 15 minutes. If this wasn't you, ignore this email.</p>
          `,
        });
      } catch (err) { console.log("Sending email failed:", err); }

      // 202 → the app shows "check your email, then tap Google again".
      // The link merges the account server-side; the app doesn't need to do anything else.
      return res.status(202).json({ message: "A verification email has been sent to link your Google account." });
    }

    // Unlike web, Mobile sessions are long-lived — mirrors mobile login's remember: true (30 days) by default.
    const { accessToken, refreshToken } = await createSession({ userId: user.id, role: user.role, remember: true, req });

    // Respond with back the user, accessToken, and refreshToken
    return res.json({
      user: { id: user.id, email, name: user.name ?? name, image: user.image ?? picture },
      accessToken,
      refreshToken,
    });
  } catch (err) { next(err); }             // catch errors and pass to error handler
} 



// ---------------- GITHUB OAUTH CONTROLLER (MOBILE — authorization code + PKCE) ----------------
// GitHub provides an authorization code, not an ID token. expo-auth-session sends a PKCE
// code_challenge by default, so GitHub REQUIRES code_verifier in the token exchange.
export async function githubMobileOAuth(req, res, next) {
  try {
    // Get code and codeVerifier from req.body, if no code or codeVerifier return 400
    const { code, codeVerifier } = req.body;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ message: "code is required" });
    }
    if (!codeVerifier || typeof codeVerifier !== 'string') {
      return res.status(400).json({ message: "codeVerifier is required" });
    }

    // Exchange the code using the MOBILE redirect URI + PKCE verifier
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        code,
        client_id: GITHUB.clientId,
        client_secret: GITHUB.clientSecret,
        redirect_uri: process.env.GITHUB_MOBILE_REDIRECT_URI,
        code_verifier: codeVerifier,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(400).json({ message: "Failed to get GitHub access token" });
    }

    // Fetch profile and verified primary email
    const profileRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!profileRes.ok) return res.status(400).json({ message: "Failed to fetch GitHub profile" });
    const profile = await profileRes.json();

    const emailsRes = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const emails = await emailsRes.json();
    if (!Array.isArray(emails)) return res.status(400).json({ message: "Failed to fetch GitHub emails" });
    const primary = emails.find((e) => e.primary && e.verified);
    if (!primary) return res.status(403).json({ message: "No verified email found" });
    const email = primary.email.trim().toLowerCase();

    // Same create / ban / merge / session logic as web
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          name: profile.name || profile.login,
          image: profile.avatar_url,
          password: null,
          githubId: String(profile.id),
          isEmailVerified: true,
        },
      });
    }
    if (user.bannedAt) return res.status(403).json({ message: "Your account has been suspended" });

    if (user.password && !user.githubId) {
      const mergeToken = crypto.randomUUID();
      const hashedMergeToken = await hashItem(mergeToken);
      await prisma.user.update({
        where: { email },
        data: {
          mergeToken: hashedMergeToken,
          mergeTokenExpiry: new Date(Date.now() + 1000 * 60 * 15),
          pendingGithubId: String(profile.id),
        },
      });
      try {
        await sendEmail({
          to: email,
          subject: "Link your GitHub account",
          html: `
            <p>Someone tried to sign in with GitHub using this email.</p>
            <p>If this was you, click below to link your GitHub account:</p>
            <a href="${process.env.BACKEND_ORIGIN}/api/v1/auth/link-account?token=${mergeToken}&email=${encodeURIComponent(email)}"> Link GitHub Account </a>
            <p>Expires in 15 minutes.</p>
          `,
        });
      } catch (err) { console.log("Sending email failed:", err); }
      return res.status(202).json({ message: "A verification email has been sent to link your GitHub account." });
    }

    // Unlike web, Mobile sessions are long-lived — mirrors mobile login's remember: true (30 days) by default.
    const { accessToken, refreshToken } = await createSession({ userId: user.id, role: user.role, remember: true, req, });
    
    // Respond with user info, the tokens
    return res.json({
      user: { id: user.id, email, name: user.name ?? profile.name, image: user.image ?? profile.avatar_url },
      accessToken,
      refreshToken,
    });
  } catch (err) { next(err); }    // catch errors and pass to error handler
}