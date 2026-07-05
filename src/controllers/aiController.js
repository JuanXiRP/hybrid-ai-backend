import ChatHistory from '../models/ChatHistory.js';
import WorkoutPlan from '../models/WorkoutPlan.js';
import { generateWorkoutPlan, processChatMessage } from '../services/geminiService.js';

// Size limits for coach chat context (no tokenizer available; ~4 chars/token heuristic)
const MAX_PLAN_CONTEXT_CHARS = 6000; // ~1.5k tokens
const MAX_HISTORY_TURNS = 20;        // keep only the most recent turns

// Tolerant sanitization of client-sent conversation history.
// Keeps valid { role: 'user' | 'model', content: string } turns, drops leading 'model'
// turns (Gemini history must start with 'user') and a trailing 'user' turn (the current
// message is appended separately, avoiding two consecutive user turns).
const sanitizeHistory = (arr) => {
    const turns = (Array.isArray(arr) ? arr : [])
        .filter(
            (m) =>
                m &&
                (m.role === 'user' || m.role === 'model') &&
                typeof m.content === 'string' &&
                m.content.trim() !== ''
        )
        .map((m) => ({ role: m.role, content: m.content }));

    while (turns.length && turns[0].role === 'model') turns.shift();
    while (turns.length && turns[turns.length - 1].role === 'user') turns.pop();
    return turns;
};

// @desc    Generate a workout plan using Gemini AI and save it to DB
// @route   POST /api/ai/generate-plan
// @access  Public (Pending JWT implementation)
export const generatePlan = async (req, res) => {
    try {
        const userId = req.user._id;

        // Build the profile for Gemini from the PERSISTED user (source of truth for
        // onboarding data like injuries and last_period_date), letting the request body
        // override for one-off tweaks. This guarantees cycle/injury context reaches the prompt
        // even though those fields are saved via PATCH /profile, not resent here.
        const userProfile = { ...req.user.toObject(), ...req.body };
        const planDuration = req.body.planDuration ?? req.user.planDuration;
        const goal = req.body.goal ?? req.user.goal;

        // 1. Call Gemini Service
        const rawAiResponse = await generateWorkoutPlan(userProfile);
        
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
        const { message, plan_context, history: clientHistory } = req.body;
        const userId = req.user._id;

        if (!message) return res.status(400).json({ success: false, message: "Message is required" });

        // 1. Resolve plan context: prefer the client-sent text summary; otherwise fall back to
        // the persisted active plan (previous behavior). Truncate to bound prompt cost.
        let planContext = typeof plan_context === 'string' ? plan_context.trim() : '';
        if (!planContext) {
            const activeRoutine = await WorkoutPlan.findOne({ userId }).sort({ createdAt: -1 });
            if (activeRoutine) planContext = JSON.stringify(activeRoutine);
        }
        if (planContext.length > MAX_PLAN_CONTEXT_CHARS) {
            planContext = planContext.slice(0, MAX_PLAN_CONTEXT_CHARS) + '… [truncated]';
        }

        // 2. Fetch or create the durable chat history log
        let history = await ChatHistory.findOne({ userId });
        if (!history) {
            history = await ChatHistory.create({ userId, messages: [] });
        }

        // 3. Resolve conversation history: prefer the client-sent turns; otherwise fall back to
        // the persisted log (previous behavior). Keep only the most recent turns.
        const hasClientHistory = Array.isArray(clientHistory) && clientHistory.length > 0;
        const conversation = (hasClientHistory ? sanitizeHistory(clientHistory) : history.messages)
            .slice(-MAX_HISTORY_TURNS);

        // 4. Call Gemini via Service
        const aiResponseText = await processChatMessage(conversation, message, planContext);

        // 5. Append both messages to the durable log
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