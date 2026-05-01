import WorkoutPlan from '../models/WorkoutPlan.js';

// @desc    Get the user's currently active workout plan
// @route   GET /api/plans/active
// @access  Private
export const getActivePlan = async (req, res) => {
    try {
        // Find the most recent active plan for the authenticated user
        const activePlan = await WorkoutPlan.findOne({ 
            userId: req.user._id, 
            active: true 
        }).sort({ createdAt: -1 });

        if (!activePlan) {
            return res.status(404).json({ 
                success: false, 
                message: "No active workout plan found" 
            });
        }

        res.status(200).json({
            success: true,
            data: activePlan
        });
    } catch (error) {
        console.error("[Get Active Plan Error]:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
};

// @desc    Get all workout plans for the user (History)
// @route   GET /api/plans/history
// @access  Private
export const getPlanHistory = async (req, res) => {
    try {
        // Fetch all plans, sorted by newest first, excluding the massive 'weeks' array to save bandwidth
        const plans = await WorkoutPlan.find({ userId: req.user._id })
                                       .sort({ createdAt: -1 })
                                       .select('-weeks');

        res.status(200).json({
            success: true,
            count: plans.length,
            data: plans
        });
    } catch (error) {
        console.error("[Get Plan History Error]:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
};