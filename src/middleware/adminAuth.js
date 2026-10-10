// Admin authorization middleware. Runs AFTER `auth.js`, which has already verified the access token and refreshed `req.user.role` from the DB. A demoted admin is rejected on their very next request
export function adminAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  if (req.user.role !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
}


// tiny middleware used on delete route to prevent self-delete from admin dashboard by mistake, if admin needs to delete his account, He can do it from the website itself (profile page)
// We need it because we're using the same delete controller for both users & admins (so we can't set this in the controller itself).
export function preventSelfDelete(req, res, next) {
  if (req.user.id === req.params.id) {
    return res.status(400).json({
      message: "You cannot delete your own account from the admin panel",
    });
  }
  next();
}


