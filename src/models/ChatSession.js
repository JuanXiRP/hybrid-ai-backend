import mongoose from "mongoose";

// One coach conversation per user.
//
// The thread lives here and its turns live in ChatMessage, which is the whole point of the
// split: the previous design kept every message inside a single unbounded array on one
// document, so reading the last two turns meant loading the entire conversation, and the
// document grew until MongoDB's 16 MB ceiling would have ended it.
//
// `userId` is unique because a user has exactly one thread today. It is also what makes the
// upsert in chatRepository.getOrCreateSession atomic: two concurrent first messages race to
// insert, one wins, the loser reads the winner's document instead of creating a second thread.
const chatSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    // Denormalised cursor. Kept in step with the messages by touchSession so that listing or
    // sorting conversations never has to touch ChatMessage at all.
    lastMessageAt: { type: Date, default: Date.now, required: true },
    messageCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export default mongoose.model("ChatSession", chatSessionSchema);
