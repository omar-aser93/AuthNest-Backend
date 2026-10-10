import express from 'express';
import auth from '../../middleware/auth.js';
import optionalAuth from '../../middleware/optionalAuth.js';
import { csrfProtection } from "../../middleware/csrf.js";
import { validate } from '../../middleware/validate.js';
import { changePasswordSchema } from '../../utils/validator.js';
import { upload } from "../../middleware/upload.js";
import { getMyProfile, getUserById, updateUser, changePassword, deleteUser, searchUsersForMention, searchUsers } from '../../controllers/userController.js';

const router = express.Router();                 // Create router instance


router.get('/me', auth, getMyProfile);                   // get my profile (protected)
router.get('/search', auth, searchUsersForMention);      // search users for mention (protected)
router.get('/search-users', optionalAuth, searchUsers);  // search users (public, optional auth for personalized results if logged in)
router.get('/:id', getUserById);                         // get user by id (public)
router.put('/:id', auth, csrfProtection, upload, updateUser);  // update user (protected) & with image upload
router.post('/:id/change-password', auth, csrfProtection, validate(changePasswordSchema), changePassword);   // change password (protected) & with CSRF protection
router.delete('/:id', auth, csrfProtection, deleteUser);  // delete user (protected) & with CSRF protection

export default router;
 
