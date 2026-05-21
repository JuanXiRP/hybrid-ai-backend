// src/routes/aiRoutes.js
import express from 'express';
import { generatePlan, chatWithCoach } from '../controllers/aiController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/generate-plan', protect, generatePlan);
router.post('/chat', protect, chatWithCoach); 

export default router;