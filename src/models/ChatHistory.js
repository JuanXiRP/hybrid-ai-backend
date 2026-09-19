import mongoose from "mongoose";

// SUPERSEDED by ChatSession + ChatMessage, which store one row per turn instead of an unbounded
// array on a single document per user.
//
// Nothing in the running application reads or writes this model any more; its only importer is
// scripts/migrate-chat-history.js. It is kept for one release so that rolling the code back
// restores a complete, untouched transcript — the migration copies out of it and never mutates
// `messages`. Delete the model and drop the collection once the migration has soaked.
const chatHistorySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
      // Ensures only one active chat history document per user
      unique: true,
    },
    // Array storing the chronological conversation
    messages: [
      {
        role: {
          type: String,
          enum: ["user", "model"],
          required: true,
        },
        content: {
          type: String,
          required: true,
        },
        timestamp: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // Stamped by the migration script so a re-run can report what is already done. The real
    // idempotency barrier is ChatMessage.legacyImport, which lets the script replace its own
    // previous import without ever touching a turn the live application wrote.
    migratedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  },
);

export default mongoose.model("ChatHistory", chatHistorySchema);
