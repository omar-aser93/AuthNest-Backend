import bcrypt from 'bcryptjs';
import crypto from "crypto";

// ------------------ HASHING UTILITY ------------------
export async function hashItem(plain) {
  const salt = await bcrypt.genSalt(12);
  return bcrypt.hash(plain, salt);
}

// ------------------ HASH COMPARISON UTILITY ------------------
export async function compareHashed(plain, hashed) {
  return bcrypt.compare(plain, hashed);
}


// ------------------ TOKEN HASHING UTILITY (crypto sha256 is better for refresh token) ------------------
export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}


// ------------------ TOKEN HASH COMPARISON UTILITY ------------------
export function compareTokens(token, storedHash) {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
