import express from 'express';
import auth from '../../middleware/auth.js';
import optionalAuth from '../../middleware/optionalAuth.js';
import { csrfProtection } from "../../middleware/csrf.js";
import { validate } from '../../middleware/validate.js';
import { commentSchema } from '../../utils/validator.js';
import { createComment, updateComment, deleteComment, getPostComments } from '../../controllers/commentsController.js';

const router = express.Router();                  // Create router instance


router.get('/posts/:postId/comments', optionalAuth, getPostComments);      // Get post comments (optional auth) 

// Create comment (protected) & with CSRF protection & validation
router.post('/posts/:postId/comments', auth, csrfProtection, validate(commentSchema), createComment);  
// Update comment (protected) & with CSRF protection & validation
router.put('/:commentId', auth, csrfProtection, validate(commentSchema), updateComment);       
// Delete comment (protected) & with CSRF protection
router.delete('/:commentId', auth, csrfProtection, deleteComment); 

export default router;
