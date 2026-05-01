import WorkoutStrength from '../models/WorkoutStrength.js';
import WorkoutRun from '../models/WorkoutRun.js';

// @desc    Create a new strength workout record
// @route   POST /api/workouts/strength
// @access  Public (Pending JWT implementation)
export const createStrengthWorkout = async (req, res) => {
    try {
        const workout = await WorkoutStrength.create(req.body);
        
        res.status(201).json({
            success: true,
            data: workout
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

// @desc    Create a new run workout record
// @route   POST /api/workouts/run
// @access  Public (Pending JWT implementation)
export const createRunWorkout = async (req, res) => {
    try {
        const workout = await WorkoutRun.create(req.body);
        
        res.status(201).json({
            success: true,
            data: workout
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
};