import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { validate } from '../../middleware/validate.js';
import { signupSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema, otpSchema } from '../../utils/validator.js';
import { signup, login, logout, refreshToken, verifyEmail, resendVerification, forgotPassword, verifyOtp, resetPassword, googleOAuth, googleMobileOAuth, githubOAuth, githubMobileOAuth, confirmLinkAccount } from '../../controllers/authController.js';
import auth from '../../middleware/auth.js';
import { getCsrfToken } from "../../middleware/csrf.js";

const router = express.Router();           // Create router instance

// Rate limiter for login routes (max 10 requests per 10 minutes per IP)
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 10, message: { message: 'Too many attempts'},standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${String(req.body?.email ?? '').trim().toLowerCase()}` });
// Rate limiter for refresh token route (max 50 requests per 5 minutes per IP)
const refreshLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 50, message: { message: "Too many refresh attempts, try again later" }, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => ipKeyGenerator(req.ip) });


router.post('/signup', authLimiter, validate(signupSchema), signup); // Signup route with validation
router.post('/login', authLimiter, validate(loginSchema), login);    // Login route with rate limiting & validation
router.post('/refresh-token', refreshLimiter, refreshToken);         // refreshToken route with rate limiting     
router.post('/logout', logout);                                      // Logout route 

router.get("/verify-email", verifyEmail);                                    // Verify email route
router.post("/resend-verification", authLimiter, auth, resendVerification);  // Resend email verification route with auth middleware
router.post("/forgot-password", authLimiter, validate(forgotPasswordSchema), forgotPassword);   // Forgot password route with rate limiting & validation
router.post("/verify-otp", authLimiter, validate(otpSchema), verifyOtp);                        // Verify OTP route with rate limiting & validation
router.post("/reset-password", authLimiter, validate(resetPasswordSchema), resetPassword);      // Reset password route with rate limiting & validation 

router.post("/oauth/google", authLimiter, googleOAuth);      // Google OAuth route with rate limiting
router.post("/oauth/github", authLimiter, githubOAuth);      // GitHub OAuth route with rate limiting
router.get("/link-account", confirmLinkAccount);             // Link user account with his OAuth route
router.post("/oauth/google/mobile", authLimiter, googleMobileOAuth);  // Google-mobile OAuth route with rate limiting
router.post("/oauth/github/mobile", authLimiter, githubMobileOAuth);  // GitHub-mobile OAuth route with rate limiting

router.get("/csrf-token", getCsrfToken);                     // Route to issue CSRF token cookie (protection against CSRF attacks)

export default router;


