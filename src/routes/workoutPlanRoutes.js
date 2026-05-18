import express from 'express';
import { getActivePlan, getPlanHistory } from '../controllers/workoutPlanController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// All routes in this file are protected
router.use(protect); 

router.get('/active', getActivePlan);
router.get('/history', getPlanHistory);

export default router;