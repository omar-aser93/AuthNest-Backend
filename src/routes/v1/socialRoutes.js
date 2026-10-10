import express from 'express';
import auth from '../../middleware/auth.js';
import { csrfProtection } from "../../middleware/csrf.js";
import { sendFriendRequest, acceptFriendRequest, declineFriendRequest, cancelFriendRequest, removeFriend, blockUser, unblockUser, getMyFriends, getFriendRequests, getFriendSuggestions, getFriendshipStatus, removeTag, getBlockedUsers } from '../../controllers/socialController.js';

const router = express.Router();                  // Create router instance


router.get('/friends', auth, getMyFriends);                       // Get my friends list (protected)
router.get('/friends/requests', auth, getFriendRequests);         // Get pending requests (protected)
router.get('/friends/suggestions', auth, getFriendSuggestions);   // Get friend suggestions (protected)
router.get('/friends/blocked', auth, getBlockedUsers);            // Get blocked users list (protected)
router.get('/friends/status/:userId', auth, getFriendshipStatus); // Get specific user's friendship status (protected)

router.post('/friends/:userId/request', auth, csrfProtection, sendFriendRequest);        // Send friend request (protected) & with CSRF protection
router.post('/friends/:requestId/accept', auth, csrfProtection, acceptFriendRequest);    // Accept request (protected) & with CSRF protection
router.post('/friends/:requestId/decline', auth, csrfProtection, declineFriendRequest);  // Decline request (protected) & with CSRF protection
router.post('/friends/:requestId/cancel', auth, csrfProtection, cancelFriendRequest);    // Cancel my request (protected) & with CSRF protection
router.delete('/friends/:userId', auth, csrfProtection, removeFriend);                   // Remove friend/unfriend (protected) & with CSRF protection
router.post('/friends/:userId/block', auth, csrfProtection, blockUser);                  // Block user (protected) & with CSRF protection
router.post('/friends/:userId/unblock', auth, csrfProtection, unblockUser)               // Unblock user (protected) & with CSRF protection

router.delete('/tags/:tagId', auth, csrfProtection, removeTag);    // untag user (protected) & with CSRF protection

export default router;
