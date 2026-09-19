import WorkoutPlan from "../models/WorkoutPlan.js";
import { getCoachHistory, sendCoachMessage } from "../services/chatService.js";
import {
  generateWorkoutPlan,
  importAndCompleteWorkoutPlan,
} from "../services/geminiService.js";

// Limits for the plan-import payload. The route mounts a 12 MB body parser (see app.js); these
// caps are the real contract, kept well below it so a rejected upload fails as a readable 400
// rather than a bare 413. They mirror PlanAttachmentReader on the Android client.
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8 MB decoded, across all attachments
const MAX_SOURCE_TEXT_CHARS = 20000;
const BASE64_PATTERN = /^[A-Za-z0-9+/\r\n]+={0,2}$/;

// Decoded length of a base64 string, without allocating the buffer.
const decodedByteLength = (base64) => {
  const clean = base64.replace(/[\r\n]/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
};

// Returns an error message, or null when the payload is usable.
const validateImportPayload = ({ providedDomain, sourceText, attachments }) => {
  if (providedDomain !== "strength" && providedDomain !== "cardio") {
    return "providedDomain must be either 'strength' or 'cardio'";
  }

  const text = typeof sourceText === "string" ? sourceText.trim() : "";
  const files = Array.isArray(attachments) ? attachments : [];

  if (!text && files.length === 0) {
    return "Send the plan as text (sourceText) or as at least one attachment";
  }
  if (text.length > MAX_SOURCE_TEXT_CHARS) {
    return `sourceText must be at most ${MAX_SOURCE_TEXT_CHARS} characters`;
  }
  if (files.length > MAX_ATTACHMENTS) {
    return `At most ${MAX_ATTACHMENTS} attachments are allowed`;
  }

  let totalBytes = 0;
  for (const file of files) {
    if (
      !file ||
      typeof file.mimeType !== "string" ||
      typeof file.data !== "string" ||
      !file.data
    ) {
      return "Every attachment needs a mimeType and base64 data";
    }
    if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(file.mimeType)) {
      return `Unsupported attachment type "${file.mimeType}". Allowed: ${[...ALLOWED_ATTACHMENT_MIME_TYPES].join(", ")}`;
    }
    if (!BASE64_PATTERN.test(file.data)) {
      return "Attachment data must be base64-encoded";
    }
    totalBytes += decodedByteLength(file.data);
  }
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    return `Attachments must total at most ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`;
  }

  return null;
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
      weeks: parsedData.weeks || parsedData,
    });

    // 201 Created status code for successful database insertion
    res.status(201).json({
      success: true,
      data: newPlan,
    });
  } catch (error) {
    console.error("[Controller Error]:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error processing AI response",
    });
  }
};

// @desc    Parse a plan the athlete already follows and let Gemini write the missing half
// @route   POST /api/ai/import-plan
// @access  Private
export const importPlan = async (req, res) => {
  try {
    const { providedDomain, sourceText, attachments } = req.body;

    const validationError = validateImportPayload({
      providedDomain,
      sourceText,
      attachments,
    });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const userId = req.user._id;

    // Same profile resolution as generatePlan: the persisted user is the source of truth for
    // onboarding data, the body may override. The source material itself is stripped out —
    // it travels as an explicit argument, not as prompt profile fields.
    const {
      sourceText: _text,
      attachments: _files,
      ...bodyOverrides
    } = req.body;
    const userProfile = { ...req.user.toObject(), ...bodyOverrides };
    const planDuration = req.body.planDuration ?? req.user.planDuration;
    const goal = req.body.goal ?? req.user.goal;

    const rawAiResponse = await importAndCompleteWorkoutPlan(userProfile, {
      providedDomain,
      planDuration,
      sourceText: typeof sourceText === "string" ? sourceText.trim() : "",
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
        message:
          "We couldn't read a training plan in what you sent. Try a clearer document, or paste the routine as text.",
      });
    }

    const newPlan = await WorkoutPlan.create({
      userId,
      durationWeeks: planDuration,
      goal,
      origin: "imported",
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

// @desc    Send a message to the AI coach
// @route   POST /api/ai/chat
// @access  Private
//
// `plan_context` and `history` are still ACCEPTED on the wire — shipped Android builds send both
// — but deliberately ignored. The server now derives the athlete's routine itself
// (routineContextService) and owns the transcript (chatService), which is what stopped the coach
// forgetting a conversation the moment the user switched tabs. Do not reintroduce them: a
// client-supplied 'model' turn is text the assistant never said, and a client-supplied routine
// is a second source of truth for facts the database already holds.
export const chatWithCoach = async (req, res) => {
  try {
    const { message } = req.body;

    if (typeof message !== "string" || message.trim() === "") {
      return res
        .status(400)
        .json({ success: false, message: "Message is required" });
    }

    const { reply, timestamp } = await sendCoachMessage({
      userId: req.user._id,
      message: message.trim(),
    });

    res.status(200).json({ success: true, data: { reply, timestamp } });
  } catch (error) {
    console.error("[Chat Controller Error]:", error);
    res
      .status(500)
      .json({ success: false, message: "Error communicating with Coach AI" });
  }
};

// @desc    Read the stored coach conversation, newest page first
// @route   GET /api/ai/chat/history
// @access  Private
//
// Paginates backwards: `before` is the createdAt of the oldest message already on screen, which
// is how a chat UI loads more as the athlete scrolls up.
export const getChatHistory = async (req, res) => {
  try {
    const { limit, before } = req.query;

    const beforeDate = before ? new Date(before) : null;
    if (beforeDate && Number.isNaN(beforeDate.getTime())) {
      return res
        .status(400)
        .json({ success: false, message: "`before` must be a valid date" });
    }

    const { messages, hasMore } = await getCoachHistory({
      userId: req.user._id,
      limit,
      before: beforeDate,
    });

    res.status(200).json({
      success: true,
      data: {
        // snake_case on the wire, matching the client's @SerialName convention.
        messages: messages.map((entry) => ({
          role: entry.role,
          content: entry.content,
          created_at: entry.createdAt,
        })),
        has_more: hasMore,
      },
    });
  } catch (error) {
    console.error("[Chat History Error]:", error);
    res
      .status(500)
      .json({ success: false, message: "Error loading the conversation" });
  }
};
