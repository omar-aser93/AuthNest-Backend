import multer from "multer";
import path from "path";

// Allowed MIME types for posts (only images)
const allowedMimeTypes = [ "image/png", "image/jpg", "image/jpeg", "image/gif", "image/webp" ];     

// Allowed MIME types for chat attachments (wider range)
const allowedChatAttachmentTypes = [
  // images
  "image/png", "image/jpg", "image/jpeg", "image/gif", "image/webp",
  // audio
  "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav",
  // videos
  "video/mp4", "video/quicktime", "video/x-msvideo", "video/x-matroska", "video/x-flv", "video/webm", "video/mpeg",
  // documents (pdf/text/word + excel + powerpoint)
  "application/pdf", "text/plain", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation"
];


// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");   // temp folder
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});


// File filter for posts (images only)
function fileFilter(req, file, cb) {
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "Only images types are allowed for posts"), false);
  }
}

// File filter for chat (wider range of file types)
function chatFileFilter(req, file, cb) {
  if (allowedChatAttachmentTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "Invalid file type"), false);
  }
}

// Multer upload instance For single file (used in posts & user profile pictures)
export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // max 5MB per file
}).single("image");

// Multer upload instance For multiple files (used in chat messages)
export const uploadMultiple = multer({
  storage,
  fileFilter: chatFileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // max 50MB per file 
}).array("attachments", 10);   // max 10 files