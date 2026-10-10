import { verifyAccessToken } from '../utils/token.js';
import { prisma } from '../prisma.js';

// ------------------ AUTH MIDDLEWARE (HttpOnly, cookies based) ------------------
// checks for a JWT token in the cookies. If a valid token found, it attaches the user info to req.user.
// If no token or token is invalid, it returns a 401 Unauthorized response, preventing access to protected routes
// export default function auth(req, res, next) {
//   // get token from cookies, if not present, return 401 'No token
//   const token = req.cookies.accessToken;
//   if (!token) { return res.status(401).json({ message: "No token, please login" }) }
//   try {
//     const payload = verifyAccessToken(token);             // verify the token using the utility function
//     req.user = { id: payload.sub, role: payload.role };   // set req.user with user id and role
//     next();
//   } catch {
//     return res.status(401).json({ message: "Invalid or expired token" });  // return 401 if token is invalid or expired
//   }
// }



// ------ OLDER VERSION: using Authorization header 'Bearer <token>' instead of cookies (Some Backends prefer this approach [backend will be used for mobile apps as well]) ------
// checks for a JWT token in the Authorization header. If a valid token found, it attaches the user info to req.user.
// If no token or token is invalid, it returns a 401 Unauthorized response, preventing access to protected routes

// export default function auth(req, res, next) {  
//   // get Authorization header, if not present, return 401 'No token'
//   const authHeader = req.headers.authorization;
//   if (!authHeader) return res.status(401).json({ message: 'No token, please login' });

//   // check if token is in a form of 'Bearer <token>', if not, return 401 'Malformed token'
//   const parts = authHeader.split(' ');
//   if (parts.length !== 2 || parts[0] !== 'Bearer') return res.status(401).json({ message: 'Malformed token' });

//   const token = parts[1];          // extract the token
//   try {
//     const payload = verifyAccessToken(token);       // verify the token
//     // set req.user with user id and role:
//     const { sub, role } = payload;
//     req.user = { id: sub, role };
//     next();
//   } catch (err) {
//     return res.status(401).json({ message: 'Invalid or expired token' });
//   }
// }




// ----- Flexible middleware, We can use it instead to allows both cookies & Authorization header 'Bearer <token>' at the same time (web apps [cookies] and mobile apps [Authorization header]) -----
export default async function auth(req, res, next) {
  let token = null;                           // Initialize token variable

  // get Authorization header, then extract the token 'Bearer <token>'
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7);

  // If no token in Authorization header, try to get token from cookies 
  if (!token) token = req.cookies?.accessToken;

  // If no token in either places, return 401  
  if (!token) return res.status(401).json({ message: 'No token, please login' });

  try {
    const payload = verifyAccessToken(token);       // verify the token using the utility function

    // ── Ban check for apps with Admin ban system — small indexed _id lookup runs on every authenticated request, or we can comment it & allow banned user 15 min until token expires ────────────────
    // If the user was banned after their token was issued, this catches it on their next request rather than waiting for the 15-min token expiry.
    // At scaling up, replace with Redis cache or socket.io to force_logout
    const fresh = await prisma.user.findUnique({ where: { id: payload.sub }, select: { bannedAt: true, role: true } });
    if (!fresh) { return res.status(401).json({ message: 'User no longer exists' });}
    if (fresh?.bannedAt) { return res.status(403).json({ message: 'Your account has been suspended' }) }

    // set req.user with user id and role:
    // req.user = { id: payload.sub, role: payload.role };    // when there is no ban check
    req.user = { id: payload.sub, role: fresh.role };
    next();
  } catch (err) {
    // if token is invalid or expired, return 401
    if (err?.name === 'JsonWebTokenError' || err?.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
    return next(err);        // catch errors and pass to error handler
  }
}