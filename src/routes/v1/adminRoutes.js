import express from 'express';
import rateLimit from 'express-rate-limit';
import auth from '../../middleware/auth.js';
import { adminAuth, preventSelfDelete } from '../../middleware/adminAuth.js';
import { csrfProtection } from "../../middleware/csrf.js";
import { validate } from '../../middleware/validate.js';
import { loginSchema, banUserSchema, updateUserRoleSchema, updateReportSchema } from '../../utils/validator.js';
import { adminLogin, adminLogout, adminListUsers, updateUserRole, banUser, unbanUser, adminListPosts, adminGetPostById, adminListComments, adminGetCommentById,
        adminListReports, adminGetReportById, adminUpdateReport, adminStatsOverview, adminStatsTimeseries, adminStatsReportsBreakdown, adminStatsRecentActivity } from "../../controllers/adminController.js";
import { getUserById, deleteUser } from "../../controllers/userController.js";
import { deletePost } from "../../controllers/postController.js";
import { deleteComment } from "../../controllers/commentsController.js";

const router = express.Router();        // Create router instance

// Rate limiter for admin login route (max 5 requests per 10 minutes per IP) Stricter than user login  
const adminAuthLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 5, message: { message: 'Too many attempts'} });


// Admin Auth — reuse the existing refresh-token endpoint, since it is user-agnostic
router.post('/auth/login', adminAuthLimiter, validate(loginSchema), adminLogin);
router.post("/auth/logout", adminLogout);

// ── Everything below requires (auth + admin) middleware ────────────────────
router.use(auth, adminAuth);

// Users
router.get("/users", adminListUsers);           // list all users 
router.get("/users/:id", getUserById);          // get user details by id (reused from userController)                         
router.patch("/users/:id/role", csrfProtection, validate(updateUserRoleSchema), updateUserRole); // update user role
router.delete("/users/:id", csrfProtection, preventSelfDelete, deleteUser);   // delete user (reused from userController)
router.post("/users/:id/ban",   csrfProtection, validate(banUserSchema), banUser);  // ban user
router.post("/users/:id/unban", csrfProtection, unbanUser);    // unban user

// Posts
router.get("/posts", adminListPosts);            // list all posts
router.get("/posts/:id", adminGetPostById);      // get single post by id
router.delete("/posts/:id", csrfProtection, deletePost);   // delete post (reused from postController)

// Comments
router.get("/comments", adminListComments);         // list all comments
router.get("/comments/:id", adminGetCommentById);   // get single comment by id
router.delete("/comments/:commentId", csrfProtection, deleteComment);   // delete comment (reused from commentsController)

// Reports
router.get("/reports", adminListReports);          // list all reports
router.get("/reports/:id", adminGetReportById);    // get single report by id
router.patch("/reports/:id", csrfProtection, validate(updateReportSchema), adminUpdateReport);  // update report 

// Stats (dashboard home)
router.get("/stats/overview", adminStatsOverview);                    // get stats overview
router.get("/stats/timeseries", adminStatsTimeseries);                // get stats timeseries
router.get("/stats/reports-breakdown", adminStatsReportsBreakdown);   // get reports breakdown
router.get("/stats/recent-activity", adminStatsRecentActivity);       // get recent activity


export default router;


// Note: no Edit post/comment routes because social media apps, posts/comments are owned by users, admin should only delete/hide