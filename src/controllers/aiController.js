import ChatHistory from '../models/ChatHistory.js';
import WorkoutPlan from '../models/WorkoutPlan.js';
import { generateWorkoutPlan, processChatMessage } from '../services/geminiService.js';

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
// @desc    Send message to AI Coach and update history
// @route   POST /api/ai/chat
// @access  Private
export const chatWithCoach = async (req, res) => {
    try {
        const { message } = req.body;
        const userId = req.user._id;

        if (!message) return res.status(400).json({ success: false, message: "Message is required" });

        // 1. Fetch user's active routine for context
        const activeRoutine = await WorkoutPlan.findOne({ userId }).sort({ createdAt: -1 });

        // 2. Fetch or create chat history
        let history = await ChatHistory.findOne({ userId });
        if (!history) {
            history = await ChatHistory.create({ userId, messages: [] });
        }

        // 3. Call Gemini via Service
        const aiResponseText = await processChatMessage(history.messages, message, activeRoutine);

        // 4. Append both messages to the database array
        history.messages.push({ role: 'user', content: message });
        history.messages.push({ role: 'model', content: aiResponseText });
        await history.save();

        res.status(200).json({
            success: true,
            data: {
                reply: aiResponseText,
                timestamp: new Date()
            }
        });
    } catch (error) {
        console.error("[Chat Controller Error]:", error);
        res.status(500).json({ success: false, message: "Error communicating with Coach AI" });
    }
};