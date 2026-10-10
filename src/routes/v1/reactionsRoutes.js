import express from 'express';
import auth from '../../middleware/auth.js';
import { csrfProtection } from "../../middleware/csrf.js";
import { validate } from '../../middleware/validate.js';
import { reactionSchema } from '../../utils/validator.js';
import { reactToPost, removePostReaction, reactToComment, removeCommentReaction, reactToMessage, removeMessageReaction } from '../../controllers/reactionsController.js';

const router = express.Router();                  // Create router instance


// React to post (protected) & with CSRF protection & validation
router.post('/posts/:postId/reactions', auth, csrfProtection, validate(reactionSchema), reactToPost); 
// Remove post reaction (protected) & with CSRF protection     
router.delete('/posts/:postId/reactions', auth, csrfProtection, removePostReaction);            

// React to comment (protected) & with CSRF protection & validation
router.post('/comments/:commentId/reactions', auth, csrfProtection, validate(reactionSchema), reactToComment);    
// Remove comment reaction (protected) & with CSRF protection 
router.delete('/comments/:commentId/reactions', auth, csrfProtection, removeCommentReaction); 

// React to message (protected) & with CSRF protection & validation
router.post('/messages/:messageId/reactions', auth, csrfProtection, validate(reactionSchema), reactToMessage );
// Remove message reaction (protected) & with CSRF protection
router.delete('/messages/:messageId/reactions', auth, csrfProtection, removeMessageReaction);


export default router;