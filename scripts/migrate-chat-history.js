// One-off migration: legacy ChatHistory documents -> ChatSession + ChatMessage.
//
// The old model kept an entire conversation inside one array on one document per user, so every
// read loaded every message ever sent and the document grew without limit. The new collections
// store one row per turn, which is what lets the coach read a bounded window and count a daily
// quota from an index.
//
// Run it AFTER deploying the code that writes the new collections. The application stops writing
// ChatHistory at that point, so the only conversations this has to move are the ones that already
// existed. Messages sent between the deploy and this run are already in the new collections and
// are never touched here.
//
//   node scripts/migrate-chat-history.js            # apply
//   node scripts/migrate-chat-history.js --dry-run  # report only
//
// Idempotent and self-repairing: every row it writes carries `legacyImport: true`, and it deletes
// its own previous import for a session before writing it again. A crash halfway through is
// therefore fixed by running it a second time, and a live message written after the deploy can
// never be deleted by it.
//
// Rollback: purely additive. `ChatHistory.messages` is only read, never modified, so reverting
// the application code restores the old behaviour against an intact transcript.

import mongoose from "mongoose";
import dotenv from "dotenv";
import ChatHistory from "../src/models/ChatHistory.js";
import ChatMessage from "../src/models/ChatMessage.js";
import ChatSession from "../src/models/ChatSession.js";

dotenv.config();

const DRY_RUN = process.argv.includes("--dry-run");
const INSERT_CHUNK = 1000;

/** Turns the legacy array into rows, dropping anything the new schema would reject anyway. */
const readableTurns = (history) =>
  (history.messages ?? []).filter(
    (message) =>
      (message.role === "user" || message.role === "model") &&
      typeof message.content === "string" &&
      message.content.trim() !== "",
  );

const run = async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set. Refusing to run.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  let migrated = 0;
  let repaired = 0;
  let empty = 0;
  let turnsWritten = 0;

  // A cursor rather than find(): the whole point of this migration is that these documents are
  // unbounded, so they must not all be loaded at once.
  const cursor = ChatHistory.find({}).cursor();

  for await (const history of cursor) {
    const turns = readableTurns(history);
    if (turns.length === 0) {
      empty++;
      continue;
    }

    const alreadyDone = Boolean(history.migratedAt);
    if (DRY_RUN) {
      console.log(
        `${history.userId}: ${turns.length} turn(s)${alreadyDone ? " (already migrated — would be rewritten)" : ""}`,
      );
      if (alreadyDone) repaired++;
      else migrated++;
      turnsWritten += turns.length;
      continue;
    }

    // Upsert rather than create: the athlete may already have chatted since the deploy, in which
    // case their session exists and the legacy turns simply join it — in the right order, because
    // each row keeps its original timestamp.
    const session = await ChatSession.findOneAndUpdate(
      { userId: history.userId },
      {
        $setOnInsert: {
          userId: history.userId,
          lastMessageAt: history.updatedAt ?? new Date(),
        },
      },
      { upsert: true, new: true },
    );

    // Replace only what a previous run of this script wrote.
    await ChatMessage.deleteMany({
      sessionId: session._id,
      legacyImport: true,
    });

    for (let index = 0; index < turns.length; index += INSERT_CHUNK) {
      await ChatMessage.insertMany(
        turns.slice(index, index + INSERT_CHUNK).map((turn) => ({
          sessionId: session._id,
          userId: history.userId,
          role: turn.role,
          content: turn.content,
          // The original timestamp, not the migration's: the daily quota counts user turns by
          // date, so stamping them all with today would hand every migrated athlete a fresh
          // quota bill for conversations they had months ago.
          createdAt: turn.timestamp ?? history.createdAt ?? new Date(),
          legacyImport: true,
        })),
      );
    }

    // Recomputed from the collection rather than incremented, so a repair run lands on the truth
    // even if the previous attempt died midway.
    const [messageCount, newest] = await Promise.all([
      ChatMessage.countDocuments({ sessionId: session._id }),
      ChatMessage.findOne({ sessionId: session._id })
        .sort({ createdAt: -1, _id: -1 })
        .select("createdAt")
        .lean(),
    ]);
    await ChatSession.updateOne(
      { _id: session._id },
      {
        $set: {
          messageCount,
          lastMessageAt: newest?.createdAt ?? session.lastMessageAt,
        },
      },
    );

    await ChatHistory.updateOne(
      { _id: history._id },
      { $set: { migratedAt: new Date() } },
    );

    turnsWritten += turns.length;
    if (alreadyDone) repaired++;
    else migrated++;
  }

  console.log(
    [
      DRY_RUN ? "Dry run — nothing written." : "Migration complete.",
      `conversations migrated: ${migrated}`,
      `re-imported (repair):   ${repaired}`,
      `skipped (no messages):  ${empty}`,
      `turns:                  ${turnsWritten}`,
    ].join("\n  "),
  );

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error("Chat history migration failed:", error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
