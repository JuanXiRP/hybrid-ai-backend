import express from 'express';
import { createStrengthWorkout, createRunWorkout } from '../controllers/workoutController.js';

const router = express.Router();

// Routes for handling different workout types
router.post('/strength', createStrengthWorkout);
router.post('/run', createRunWorkout);

export default router;