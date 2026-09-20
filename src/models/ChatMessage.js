import mongoose from "mongoose";

// One row per conversation turn.
//
// Roles are Gemini's own vocabulary ('user' | 'model') rather than OpenAI's, because these rows
// are mapped straight into contents[] by geminiService with no translation step.
const chatMessageSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChatSession",
      required: true,
    },
    // Denormalised from the session on purpose: the daily quota count runs on every chat
    // request, and it must never have to join to answer "how many messages today".
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    role: { type: String, enum: ["user", "model"], required: true },
    content: { type: String, required: true },
    // Explicit rather than `timestamps: true`. Messages are immutable, so updatedAt is dead
    // weight; and an explicit field is what lets the migration preserve the original
    // ChatHistory timestamps instead of stamping every historical turn with the migration time.
    createdAt: { type: Date, default: Date.now, required: true },
    // Set only by scripts/migrate-chat-history.js. It is what makes a re-run idempotent: the
    // script deletes its own previous import for a session before writing it again, and can
    // never touch a turn written by the live application.
    legacyImport: { type: Boolean, default: false },
  },
  { timestamps: false },
);

// Serves the sliding-window fetch: find({sessionId}).sort({createdAt:-1,_id:-1}).limit(N).
// `_id` is part of the key so the tiebreaker is index-served too — migrated turns can share a
// timestamp to the millisecond, and without it their order would be undefined.
chatMessageSchema.index({ sessionId: 1, createdAt: -1, _id: -1 });

// Serves the freemium quota count:
// countDocuments({ userId, role: 'user', createdAt: { $gte: startOfUtcDay } }).
// Equality, equality, range — in that order — so the count is answered from the index without
// fetching a single document.
chatMessageSchema.index({ userId: 1, role: 1, createdAt: -1 });

export default mongoose.model("ChatMessage", chatMessageSchema);
