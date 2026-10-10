import express from 'express';
import auth from '../../middleware/auth.js';
import optionalAuth from '../../middleware/optionalAuth.js';
import { csrfProtection } from "../../middleware/csrf.js";
import { sharePost, getPostShares, unsharePost } from '../../controllers/shareController.js';

const router = express.Router();                  // Create router instance


router.get('/posts/:postId/shares', optionalAuth, getPostShares);     // Get post shares (optional auth)

// Share post (protected) & with CSRF protection
router.post('/posts/:postId/shares', auth, csrfProtection, sharePost);
// Unshare post (protected) & with CSRF protection       
router.delete('/posts/:postId', auth, csrfProtection, unsharePost);

export default router;