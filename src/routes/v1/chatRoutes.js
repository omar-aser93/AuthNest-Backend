import express from 'express';
import auth from '../../middleware/auth.js';
import { csrfProtection } from "../../middleware/csrf.js";
import { uploadMultiple } from '../../middleware/upload.js';
import { validate } from '../../middleware/validate.js';
import { createDMSchema, createGroupSchema, updateGroupSchema, addParticipantsSchema, removeParticipantSchema, sendMessageSchema, editMessageSchema } from '../../utils/validator.js';
import * as chat from '../../controllers/chatController.js';   // import chat controllers all at once 

const router = express.Router();     // Create router instance
router.use(auth);                    // all chat routes require auth (this will apply it to all routes)


// --- Messages ---
router.get('/conversations/:id/messages', chat.getMessages);   // paginated message history
// send message with optional files (attachments handled via REST since Socket.io is for real-time text messages)
router.post('/conversations/:id/messages', csrfProtection, uploadMultiple, validate(sendMessageSchema), chat.sendMessageWithAttachments); 

// --- Conversations ---
router.get('/conversations', chat.getConversations);                    // get all my conversations
router.post('/conversations/dm', csrfProtection, validate(createDMSchema), chat.getOrCreateDM);     // get or create a 1-on-1 DM
router.post('/conversations/group', csrfProtection, validate(createGroupSchema), chat.createGroup); // create a group chat
router.get('/conversations/:id', chat.getConversation);                 // get single conversation details
router.patch('/conversations/:id', csrfProtection, validate(updateGroupSchema), chat.updateGroup);   // rename group, update group avatar
router.delete('/conversations/:id', csrfProtection, chat.deleteConversation);                        // delete conversation (1-on-1 DM)
router.post('/conversations/:id/participants', csrfProtection, validate(addParticipantsSchema), chat.addParticipants);       // add users to group
router.delete('/conversations/:id/participants', csrfProtection, validate(removeParticipantSchema), chat.removeParticipant); // leave/remove from group
router.post("/conversations/:id/gif", csrfProtection, chat.sendGif);    // send a GIF

// --- Message actions ---
router.patch('/messages/:messageId', csrfProtection, validate(editMessageSchema), chat.editMessage);   // edit a message
router.delete('/messages/:messageId', csrfProtection, chat.deleteMessage);     // soft-delete a message

router.get('/unread', chat.getUnreadCounts);       // get unread message counts

router.post('/token', chat.generateCallToken);     // generate LIVEKIT call token (protected)


export default router;