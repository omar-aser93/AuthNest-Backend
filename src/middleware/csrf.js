// CSRF protection middleware 

import crypto from "crypto";

// middleware to issue a CSRF token, and set it as non-httpOnly cookie, So it's readable by client so he can send it in the X-CSRF-Token header.
// The CSRF double-submit pattern requires the token to be in both a cookie AND a header.
export function getCsrfToken(req, res) {
  const token = crypto.randomBytes(32).toString("hex");     // create random token
    const isProd = process.env.NODE_ENV === "production";   // check if we are in production (ENV value)
    res.cookie("csrfToken", token, {
      httpOnly: false,                         // must be JS-readable (browser)
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60 * 1000,        // 30 days to match refresh token (longest boundary)
    });
  // return token in JSON response
  return res.json({ csrfToken: token });
}


// CSRF protection middleware, Verifies that cookie csrfToken equals header x-csrf-token.
export function csrfProtection(req, res, next) {
  // If the request uses Bearer authentication (mobile app), skip CSRF (not needed because the token is in the header not in the cookie)
  if (req.headers.authorization?.startsWith('Bearer ')) {
    return next();
  }

  // Otherwise, enforce double‑submit cookie pattern (web browser)
  const cookieToken = req.cookies?.csrfToken;
  const headerToken = req.get("x-csrf-token");
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ message: "CSRF token missing or invalid" });
  }
  next();
}

