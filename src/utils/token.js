import jwt from 'jsonwebtoken';


// ------------------ TOKENS UTILITIES (create & verify) ------------------
export function createAccessToken(payload, expiresIn = '15m') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

export function createRefreshToken(payload, expiresIn = '7d') {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, process.env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
}
