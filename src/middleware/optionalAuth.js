// optionalAuth.js: If a public endpoint needs to access req.user → it should probably use optionalAuth middleware
import { verifyAccessToken } from '../utils/token.js';

// --------- OPTIONAL AUTH MIDDLEWARE (HttpOnly, cookies based) ------------------
// middleware designed for “public but personalized” routes, e.g. (getAllPosts) unauthenticated guest user can fetch feed of posts, but his post reaction/share can be displayed only when token is available (req.user).
// It checks for a JWT token in the cookies. If a valid token is found, it attaches the user info to req.user. 
// If no token or token is invalid, it simply calls next() without attaching any user info, allowing the request to proceed as a guest.
// export default function optionalAuth(req, res, next) {
//   const token = req.cookies?.accessToken;    // Get token from cookies

//   if (!token) return next();   // no user → continue as guest

//   try {
//     const payload = verifyAccessToken(token);      // verify the token using the utility function    
//     req.user = { id: payload.sub, role: payload.role };    // set req.user with user id and role
//   } catch {
//     // ignore invalid token
//   }

//   next();     // continue regardless of token validity, allowing both authenticated and unauthenticated users to access the route
// }



// ------ OLDER VERSION: using Authorization header 'Bearer <token>' instead of cookies (Some Backends prefer this approach [backend will be used for mobile apps as well]) ------
// middleware designed for “public but personalized” routes, e.g. (getAllPosts) unauthenticated guest user can fetch feed of posts, but his post reaction/share can be displayed only when token is available (req.user).
// It checks for a JWT token in the Authorization header. If a valid token found, it attaches the user info to req.user.
// If no token or token is invalid, it simply calls next() without attaching any user info, allowing the request to proceed as a guest

// export default function optionalAuth(req, res, next) {  
//   const authHeader = req.headers.authorization;    // Get Authorization header
//   if (!authHeader) return next();   // no user → continue as guest

//   const parts = authHeader.split(' ');
//   if (parts.length !== 2 || parts[0] !== 'Bearer') return next();   // no user → continue as guest

//   const token = parts[1];          // extract the token
//   try {
//     const payload = verifyAccessToken(token);       // verify the token
//     // set req.user with user id and role:
//     const { sub, role } = payload;
//     req.user = { id: sub, role };
//   } catch {
//     // ignore invalid token
//   }

//   next();     // continue regardless of token validity, allowing both authenticated and unauthenticated users to access the route
//}




// ----- Flexible middleware, We can use it instead to allows both cookies & Authorization header 'Bearer <token>' at the same time (web apps [cookies] and mobile apps [Authorization header]) -----
export default function optionalAuth(req, res, next) {
  let token = null;                           // Initialize token variable

  // get Authorization header, then extract the token 'Bearer <token>'
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7);

  // If no token in Authorization header, try to get token from cookies 
  if (!token) token = req.cookies?.accessToken;

  if (!token) return next();      // no user → continue as guest
 
  try {
    const payload = verifyAccessToken(token);              // verify the token using the utility function    
    req.user = { id: payload.sub, role: payload.role };    // set req.user with user id and role
  } catch {
    // ignore invalid token
  }
  next();     // continue regardless of token validity, allowing both authenticated and unauthenticated users to access the route            
}