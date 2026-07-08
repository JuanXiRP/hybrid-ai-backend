// src/routes/aiRoutes.js
import express from 'express';
import { generatePlan, chatWithCoach } from '../controllers/aiController.js';
import { protect } from '../middleware/authMiddleware.js';
import {
    requireActiveAccess,
    requirePlanQuota,
    requireChatQuota,
} from '../middleware/entitlementMiddleware.js';

const router = express.Router();

// The onboarding plan is the one free generation (FREE_PLAN_LIMIT), so a new user completes
// onboarding without paying. Regenerating afterwards requires premium.
router.post('/generate-plan', protect, requireActiveAccess, requirePlanQuota, generatePlan);
router.post('/chat', protect, requireActiveAccess, requireChatQuota, chatWithCoach);

export default router;
