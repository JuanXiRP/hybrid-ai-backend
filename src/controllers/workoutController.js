import WorkoutStrength from '../models/WorkoutStrength.js';
import WorkoutRun from '../models/WorkoutRun.js';

// @desc    Create a new strength workout record
// @route   POST /api/workouts/strength
// @access  Private
export const createStrengthWorkout = async (req, res) => {
    try {
        // Inject the verified user ID from the JWT payload
        const payload = {
            ...req.body,
            userId: req.user._id
        };

        const workout = await WorkoutStrength.create(payload);
        
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
// @access  Private
export const createRunWorkout = async (req, res) => {
    try {
        // Inject the verified user ID from the JWT payload
        const payload = {
            ...req.body,
            userId: req.user._id
        };

        const workout = await WorkoutRun.create(payload);
        
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