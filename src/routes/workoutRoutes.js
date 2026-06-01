import express from 'express';
import { createStrengthWorkout, createRunWorkout } from '../controllers/workoutController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// 🟢 Rutas protegidas: Requieren un Bearer Token válido desde Android
router.post('/strength', protect, createStrengthWorkout);
router.post('/run', protect, createRunWorkout);

export default router;