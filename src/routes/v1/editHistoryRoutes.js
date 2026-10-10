import express from 'express';
import auth from '../../middleware/auth.js';
import { getPostEditHistory, getCommentEditHistory, getMessageEditHistory } from '../../controllers/editHistoryController.js';

const router = express.Router();                  // Create router instance


router.get('/posts/:postId/edits', auth, getPostEditHistory);           // Get post edit history (protected)  
router.get('/comments/:commentId/edits', auth, getCommentEditHistory);  // Get comment edit history (protected)
router.get('/messages/:messageId/edits', auth, getMessageEditHistory);  // Get message edit history (protected)

export default router;