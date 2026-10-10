import express from 'express';
import auth from '../../middleware/auth.js';
import { csrfProtection } from "../../middleware/csrf.js";
import { validate } from '../../middleware/validate.js';
import { createReportSchema } from '../../utils/validator.js';
import { createReport, getMyReports } from '../../controllers/reportController.js';

const router = express.Router();           // Create router instance

// Create report (protected & with CSRF protection & validation)
router.post('/', auth, csrfProtection, validate(createReportSchema), createReport);  
router.get('/me', auth, getMyReports);                // get my reports (protected)                                 

export default router;