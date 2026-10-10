import { z } from 'zod';

// Ensure email is trimmed and lowercase, will use it in any schema that requires email
const emailField = z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.email().max(100));


// ---------------------- SIGNUP Schema ----------------------
export const signupSchema = z.object({
  name: z.string().min(3).max(50),
  email: emailField,
  password: z.string().min(6).max(72),
});

// ---------------------- LOGIN Schema ----------------------
export const loginSchema = z.object({
  email: emailField,
  password: z.string().min(6),
  remember: z.boolean().optional(),
});

// ---------------------- POST Schema ----------------------
export const postSchema = z.object({
  title: z.string().min(3).max(120),
  content: z.string().min(10),
  privacy: z.enum(['PUBLIC', 'FRIENDS', 'ONLY_ME', 'CUSTOM']).optional().default('PUBLIC'),
  //CUSTOM privacy(allowed & blocked) check if no value -> empty array, if array -> store it, if single value -> wrap it in array first
  allowed: z.union([z.array(z.string()), z.string()]).optional().transform(val => { if (!val) return []; return Array.isArray(val) ? val : [val]; }),
  blocked: z.union([z.array(z.string()), z.string()]).optional().transform(val => { if (!val) return []; return Array.isArray(val) ? val : [val]; }),
  hashtags: z.array(z.string()).optional().default([]),
  taggedUsers: z.array(z.string()).optional().default([]),
  // If privacy is CUSTOM, allowed array must have at least one user
}).refine((data) => {  
    if (data.privacy === 'CUSTOM') { return data.allowed && data.allowed.length > 0; } return true;}, { message: "For CUSTOM privacy, you must specify at least one allowed user", path: ["allowed"]}
  );

// ---------------------- UPDATE POST Schema ----------------------
export const updatePostSchema = z.object({
  title: z.string().min(3).max(120).optional(),
  content: z.string().min(10).optional(),
  privacy: z.enum(['PUBLIC', 'FRIENDS', 'ONLY_ME', 'CUSTOM']).optional(),
  //CUSTOM privacy (allowed & blocked) check if no value -> undefined, if array -> store it, if single value -> wrap it in array first
  allowed: z.union([z.array(z.string()), z.string()]).optional().transform(val => { if (!val) return undefined; return Array.isArray(val) ? val : [val]; }),
  blocked: z.union([z.array(z.string()), z.string()]).optional().transform(val => { if (!val) return undefined; return Array.isArray(val) ? val : [val]; }),
  hashtags: z.array(z.string()).optional(),
  taggedUsers: z.array(z.string()).optional(),
  // If privacy is CUSTOM, allowed array must have at least one user
}).refine((data) => {
    if (data.privacy === 'CUSTOM') { return data.allowed && data.allowed.length > 0; } return true;}, { message: "For CUSTOM privacy, you must specify at least one allowed user", path: ["allowed"]}
  );

// ---------------------- FORGOT PASSWORD Schema ----------------------
export const forgotPasswordSchema = z.object({
  email: emailField,
});

// ---------------------- OTP Schema ----------------------
export const otpSchema = z.object({
  email: emailField,
  otp: z.string().length(6).regex(/^\d{6}$/),
});

// ---------------------- RESET PASSWORD Schema ----------------------
export const resetPasswordSchema = z.object({
  email: emailField,
  resetToken: z.uuid(),
  newPassword: z.string().min(6).max(72),
});

// ---------------------- CHANGE PASSWORD Schema ----------------------
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6).max(72),
});


// ---------------------- COMMENT Schema ----------------------
export const commentSchema = z.object({
  content: z.string().min(1).max(700),
  parentId: z.string().optional(),              // For replies
  taggedUsers: z.array(z.string()).optional(),  // User IDs to tag
});

// ---------------------- REACTION Schema ----------------------
export const reactionSchema = z.object({
  type: z.enum(['LIKE', 'LOVE', 'HAHA', 'WOW', 'SAD', 'ANGRY'])
});


// ---------------------- CHAT Schemas ----------------------
export const createDMSchema = z.object({
  targetUserId: z.string().min(1),
});

export const createGroupSchema = z.object({
  name: z.string().min(1).max(100),
  participantIds: z.array(z.string()).min(1, 'At least one participant is required'),
});

export const updateGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'At least one field to update is required' });

export const addParticipantsSchema = z.object({
  userIds: z.array(z.string()).min(1, 'At least one user is required'),
});

export const removeParticipantSchema = z.object({
  targetUserId: z.string().optional(),  // omit to leave yourself
});

export const sendMessageSchema = z.object({
  content: z.string().min(1).max(5000).optional(),
  taggedUserIds: z.union([z.array(z.string()), z.string()])
    .optional().transform(val => { if (!val) return []; return Array.isArray(val) ? val : [val]; }),
  // files validated by multer, not zod
});

export const editMessageSchema = z.object({
  content: z.string().min(1).max(5000),
});


// ---------------------- SEARCH Schema ----------------------
export const searchSchema = z.object({
  q: z.string().min(1).max(100),
  type: z.enum(['users', 'posts', 'comments', 'all']).optional(),
  limit: z.number().min(1).max(50).optional().default(20),
  cursor: z.string().optional(),
});


// ---------------------- UPDATE USER ROLE Schema ----------------------
export const updateUserRoleSchema = z.object({
  role: z.enum(["user", "admin"]),
});


// ---------------------- REPORT Schemas ----------------------
export const createReportSchema = z.object({
  targetType: z.enum(["POST", "COMMENT", "USER"]),
  targetId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid target ID"),
  reason: z.enum([
    "SPAM", "HARASSMENT", "HATE_SPEECH", "VIOLENCE", "NUDITY",
    "FALSE_INFO", "COPYRIGHT", "IMPERSONATION", "OTHER",
  ]),
  description: z.string().max(500, "Description too long").optional(),
});

export const updateReportSchema = z.object({
  status: z.enum(["REVIEWED", "ACTIONED", "DISMISSED"]),
  resolutionNote: z.string().max(500).optional(),
});


// ---------------------- BAN USER Schema ----------------------
export const banUserSchema = z.object({
  reason: z.string().max(500, "Reason cannot exceed 500 characters").optional(),
});