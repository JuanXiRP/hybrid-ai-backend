import ChatHistory from '../models/ChatHistory.js';
import WorkoutPlan from '../models/WorkoutPlan.js';
import {
    generateWorkoutPlan,
    importAndCompleteWorkoutPlan,
    processChatMessage,
} from '../services/geminiService.js';

// Size limits for coach chat context (no tokenizer available; ~4 chars/token heuristic)
const MAX_PLAN_CONTEXT_CHARS = 6000; // ~1.5k tokens
const MAX_HISTORY_TURNS = 20;        // keep only the most recent turns

// Limits for the plan-import payload. The route mounts a 12 MB body parser (see app.js); these
// caps are the real contract, kept well below it so a rejected upload fails as a readable 400
// rather than a bare 413. They mirror PlanAttachmentReader on the Android client.
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
]);
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8 MB decoded, across all attachments
const MAX_SOURCE_TEXT_CHARS = 20000;
const BASE64_PATTERN = /^[A-Za-z0-9+/\r\n]+={0,2}$/;

// Decoded length of a base64 string, without allocating the buffer.
const decodedByteLength = (base64) => {
    const clean = base64.replace(/[\r\n]/g, '');
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return Math.floor((clean.length * 3) / 4) - padding;
};

// Returns an error message, or null when the payload is usable.
const validateImportPayload = ({ providedDomain, sourceText, attachments }) => {
    if (providedDomain !== 'strength' && providedDomain !== 'cardio') {
        return "providedDomain must be either 'strength' or 'cardio'";
    }

    const text = typeof sourceText === 'string' ? sourceText.trim() : '';
    const files = Array.isArray(attachments) ? attachments : [];

    if (!text && files.length === 0) {
        return 'Send the plan as text (sourceText) or as at least one attachment';
    }
    if (text.length > MAX_SOURCE_TEXT_CHARS) {
        return `sourceText must be at most ${MAX_SOURCE_TEXT_CHARS} characters`;
    }
    if (files.length > MAX_ATTACHMENTS) {
        return `At most ${MAX_ATTACHMENTS} attachments are allowed`;
    }

    let totalBytes = 0;
    for (const file of files) {
        if (!file || typeof file.mimeType !== 'string' || typeof file.data !== 'string' || !file.data) {
            return 'Every attachment needs a mimeType and base64 data';
        }
        if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(file.mimeType)) {
            return `Unsupported attachment type "${file.mimeType}". Allowed: ${[...ALLOWED_ATTACHMENT_MIME_TYPES].join(', ')}`;
        }
        if (!BASE64_PATTERN.test(file.data)) {
            return 'Attachment data must be base64-encoded';
        }
        totalBytes += decodedByteLength(file.data);
    }
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
        return `Attachments must total at most ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`;
    }

    return null;
};

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

// @desc    Parse a plan the athlete already follows and let Gemini write the missing half
// @route   POST /api/ai/import-plan
// @access  Private
export const importPlan = async (req, res) => {
    try {
        const { providedDomain, sourceText, attachments } = req.body;

        const validationError = validateImportPayload({ providedDomain, sourceText, attachments });
        if (validationError) {
            return res.status(400).json({ success: false, message: validationError });
        }

        const userId = req.user._id;

        // Same profile resolution as generatePlan: the persisted user is the source of truth for
        // onboarding data, the body may override. The source material itself is stripped out —
        // it travels as an explicit argument, not as prompt profile fields.
        const { sourceText: _text, attachments: _files, ...bodyOverrides } = req.body;
        const userProfile = { ...req.user.toObject(), ...bodyOverrides };
        const planDuration = req.body.planDuration ?? req.user.planDuration;
        const goal = req.body.goal ?? req.user.goal;

        const rawAiResponse = await importAndCompleteWorkoutPlan(userProfile, {
            providedDomain,
            planDuration,
            sourceText: typeof sourceText === 'string' ? sourceText.trim() : '',
            attachments: Array.isArray(attachments) ? attachments : [],
        });

        // Direct parsing is safe here because responseMimeType guarantees pure JSON
        const parsedData = JSON.parse(rawAiResponse);
        const weeks = Array.isArray(parsedData.weeks) ? parsedData.weeks : [];

        // Rule 8 of the import prompt: an empty weeks array is how the model says "I could not
        // find a training program in this". That is a user-fixable problem, not a server error.
        if (weeks.length === 0) {
            return res.status(422).json({
                success: false,
                message: "We couldn't read a training plan in what you sent. Try a clearer document, or paste the routine as text.",
            });
        }

        const newPlan = await WorkoutPlan.create({
            userId,
            durationWeeks: planDuration,
            goal,
            origin: 'imported',
            weeks,
        });

        res.status(201).json({
            success: true,
            data: newPlan,
        });
    } catch (error) {
        console.error("[Import Controller Error]:", error);
        res.status(500).json({
            success: false,
            message: error.message || "Error processing AI response",
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