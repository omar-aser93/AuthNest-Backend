import { prisma } from '../prisma.js';


// ------ Get my notifications Controller -------------
export async function getMyNotifications(req, res, next) {
  try {
    const limit = parseInt(req.query.limit) || 20;        // get limit from URL query, default to 20
    const cursor = req.query.cursor;                      // get cursor from URL query (for infinite scroll)
    const unreadOnly = req.query.unread === 'true';       // get unread from URL query

    const where = { userId: req.user.id };        // filter by user id
    if (unreadOnly) where.isRead = false;         // append (isRead=false) to the filter if unreadOnly -> true

    // fetch notifications from db (include all Extra needed info -> DB related models)
    const notifications = await prisma.notification.findMany({
      take: limit + 1,                                  // +1 to check if there are more notifications after the limit
      skip: cursor ? 1 : 0,                             // skip the extra notification if there is a cursor
      cursor: cursor ? { id: cursor } : undefined,      // set the cursor indicator
      where,                                            // apply filters
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], // order 'desc' by createdAt + id (to ensure consistent order when createdAt is the same)
      include: {
        sender: { select: { id: true, name: true, image: true } },
        post: { select: { id: true, title: true } },
        comment: { select: { id: true, content: true } },
        share: { select: { id: true, message: true } },
        tag: { include: { taggedBy: { select: { id: true, name: true, image: true } }, post: { select: { id: true, title: true } }, comment: { select: { id: true }} } },
        request: { include: { requester: { select: { id: true, name: true, image: true } }, receiver: { select: { id: true, name: true, image: true } } } },
      },
    });

    // if there are more notifications than the limit, set next cursor
    let nextCursor = null;
    if (notifications.length > limit) { nextCursor = notifications[limit-1].id; notifications.pop(); }

    res.json({ notifications, nextCursor });     // respond with notifications and next cursor (infinite scroll pagination)
  } catch (err) { next(err); }                   // catch errors and pass to error handler
}



// --------------- Mark notification as read Controller --------------
export async function markNotificationAsRead(req, res, next) {
  try {
    // update notification in db by id & user-id (to ensure user owns the notification)
    const result = await prisma.notification.updateMany({ where: { id: req.params.id, userId: req.user.id }, data: { isRead: true } });
    // if this notification not found return 404 "Notification not found"
    if (result.count === 0) return res.status(404).json({ message: 'Notification not found' });
    res.json({ message: 'Marked as read' });       // respond with success message
  } catch (err) { next(err); }                     // catch errors and pass to error handler
}



// --------------- Mark all notifications as read Controller --------------
export async function markAllNotificationsAsRead(req, res, next) {
  try {
    // update all notifications to read in db, by current user id
    await prisma.notification.updateMany({ where: { userId: req.user.id, isRead: false }, data: { isRead: true } });
    res.json({ message: 'All notifications marked as read' });    // respond with success message
  } catch (err) { next(err); }                                    // catch errors and pass to error handler
}



// --------------- Delete notification Controller --------------
export async function deleteNotification(req, res, next) {
  try {
    // delete notification from db by id & user id (to ensure user owns the notification)
    const result = await prisma.notification.deleteMany({ where: { id: req.params.id, userId: req.user.id }});
    // if this notification not found return 404 "Notification not found"
    if (result.count === 0) return res.status(404).json({ message: 'Notification not found' });
    res.json({ message: 'Notification deleted' });        // respond with success message
  } catch (err) { next(err); }                            // catch errors and pass to error handler
}



// ------------ Get unread-notifications count Controller ------------
export async function getUnreadCount(req, res, next) {
  try {
    // count unread notifications in db, by current user id
    const count = await prisma.notification.count({ where: { userId: req.user.id, isRead: false } });
    res.json({ count });                 // respond with count
  } catch (err) { next(err); }           // catch errors and pass to error handler
} 