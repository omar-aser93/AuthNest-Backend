import express from 'express';
import auth from '../../middleware/auth.js';
import { csrfProtection } from "../../middleware/csrf.js";
import { getMyNotifications, markNotificationAsRead, markAllNotificationsAsRead, deleteNotification, getUnreadCount } from '../../controllers/notificationsController.js';

const router = express.Router();                  // Create router instance


router.get('/', auth, getMyNotifications);                 // Get my notifications (protected)
router.get('/unread-count', auth, getUnreadCount);         // Get unread notifications count (protected)
router.put('/:id/read', auth, csrfProtection, markNotificationAsRead);     // Mark as read (protected) & with CSRF protection
router.put('/read-all', auth, csrfProtection, markAllNotificationsAsRead); // Mark all as read (protected) & with CSRF protection
router.delete('/:id', auth, csrfProtection, deleteNotification);           // Delete notification (protected) & with CSRF protection

export default router;
