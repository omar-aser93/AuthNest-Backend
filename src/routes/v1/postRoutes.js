import express from 'express';
import auth from '../../middleware/auth.js';
import optionalAuth from '../../middleware/optionalAuth.js';
import { csrfProtection } from "../../middleware/csrf.js";
import { upload } from "../../middleware/upload.js";
import { validate } from '../../middleware/validate.js';
import { postSchema, updatePostSchema } from '../../utils/validator.js';
import { createPost, getAllPosts, getMyPosts, getPostById, updatePost, deletePost, listPostsByUser, getPostsByHashtag, getTrendingHashtags, searchHashtags } from '../../controllers/postController.js';

const router = express.Router();            // Create router instance


router.get('/', optionalAuth, getAllPosts);                    // list all posts (optional auth) 
router.get('/me', auth, getMyPosts);                           // get my posts (protected)
router.get('/user/:userId', optionalAuth, listPostsByUser);    // list posts by user id (optional auth)
router.get('/hashtag/:tag', optionalAuth, getPostsByHashtag);  // get posts by hashtag (optional auth)
router.get("/trending", getTrendingHashtags);                  // get trending hashtags (public)
router.get('/search/hashtags', searchHashtags);                // search hashtags (public)
router.get('/:id', optionalAuth, getPostById);                 // get single post by id (optional auth)

// create post (protected) & with image upload & validation
router.post('/', auth, csrfProtection, upload, validate(postSchema), createPost); 
// update post (protected) & with image upload & validation & CSRF protection
router.put('/:id', auth, csrfProtection, upload, validate(updatePostSchema), updatePost);    
// delete post (protected) & with CSRF protection  
router.delete('/:id', auth, csrfProtection, deletePost);        


export default router;

