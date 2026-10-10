import express from "express";
import auth from "../../middleware/auth.js";
import { csrfProtection } from "../../middleware/csrf.js";
import { savePost, removeSavedPost, toggleSavedPost, getMySavedPosts } from "../../controllers/savedPostController.js";

const router = express.Router();               // Create router instance


router.get("/", auth, getMySavedPosts);                                // get my saved posts (protected)
router.post("/:postId", auth, csrfProtection, savePost);               // save post (protected) & with CSRF protection
router.delete("/:postId", auth, csrfProtection, removeSavedPost);      // remove saved post (protected) & with CSRF protection
router.post("/:postId/toggle", auth, csrfProtection, toggleSavedPost); // toggle saved post (protected) & with CSRF protection

export default router;
