import express from 'express';
import { createStrengthWorkout, createRunWorkout } from '../controllers/workoutController.js';
import { protect } from '../middleware/authMiddleware.js';
import { requireActiveAccess } from '../middleware/entitlementMiddleware.js';

const router = express.Router();

// 🟢 Rutas protegidas: Requieren un Bearer Token válido desde Android
// Writes stop once the free trial expires; reads (GET /api/plans/*) stay open, so an expired
// user keeps their plan and history read-only.
router.post('/strength', protect, requireActiveAccess, createStrengthWorkout);
router.post('/run', protect, requireActiveAccess, createRunWorkout);

export default router;
