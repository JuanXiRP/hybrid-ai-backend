
import { generateWorkoutPlan } from '../services/geminiService.js';
import WorkoutPlan from '../models/WorkoutPlan.js';

// @desc    Generate a workout plan using Gemini AI and save it to DB
// @route   POST /api/ai/generate-plan
// @access  Public (Pending JWT implementation)
export const generatePlan = async (req, res) => {
    try {
        // Destructure required fields from the request body
        const {planDuration, goal } = req.body;
        const userId = req.user._id;

        // 1. Call Gemini Service
        const rawAiResponse = await generateWorkoutPlan(req.body);
        
        // Direct parsing is safe here because responseMimeType guarantees pure JSON
        const parsedData = JSON.parse(rawAiResponse);

        // 2. Persist the newly generated plan in MongoDB
        const newPlan = await WorkoutPlan.create({
            userId,
            durationWeeks: planDuration,
            goal,
            // Fallback in case the AI wraps the array in a "weeks" property or sends it directly
            weeks: parsedData.weeks || parsedData 
        });

        // 201 Created status code for successful database insertion
        res.status(201).json({
            success: true,
            data: newPlan
        });
    } catch (error) {
        console.error("[Controller Error]:", error);
        res.status(500).json({
            success: false,
            message: error.message || "Error processing AI response"
        });
    }
};