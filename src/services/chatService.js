// Orchestration for one coach turn. The controller calls exactly one function here and does no
// data access of its own.
//
// The whole point of this module is the ORDER of a request:
//
//   1. resolve the athlete's conversation,
//   2. hydrate the routine and load the sliding window (in parallel — neither needs the other),
//   3. ask Gemini, with [system prompt + routine] -> [history] -> [new message],
//   4. persist the exchange before answering.
//
// Step 4 is deliberately awaited rather than fired and forgotten. The freemium gate counts
// PERSISTED user turns (entitlementService), so a floating write lets two concurrent requests
// both read the same count and both pass a quota that is already spent; and a crash between the
// reply and the write drops an exchange the athlete has already read. One insertMany of two
// small documents costs a few milliseconds against a Gemini call measured in seconds.

import {
  appendMessages,
  findRecentMessages,
  findSessionByUser,
  getOrCreateSession,
  touchSession,
} from "../repositories/chatRepository.js";
import { buildWindow, windowMaxTurns } from "./chatWindow.js";
import { generateCoachReply } from "./geminiService.js";
import { buildRoutineContext } from "./routineContextService.js";

const historyPageSize = () => Number(process.env.CHAT_HISTORY_PAGE_SIZE ?? 50);

/**
 * @typedef {Object} CoachChatResult
 * @property {string} reply
 * @property {Date} timestamp when the reply was produced, and its stored timestamp
 */

/**
 * Answer one message from the athlete and record the exchange.
 *
 * @param {{userId: any, message: string, now?: Date}} input
 * @returns {Promise<CoachChatResult>}
 * @throws whatever geminiService throws — nothing is persisted in that case, so a failed turn
 *   costs the athlete neither a quota message nor a corrupted transcript
 */
export const sendCoachMessage = async ({
  userId,
  message,
  now = new Date(),
}) => {
  const session = await getOrCreateSession(userId, now);

  const [routineContext, stored] = await Promise.all([
    buildRoutineContext(userId, now),
    findRecentMessages({ sessionId: session._id, limit: windowMaxTurns() }),
  ]);

  // The repository returns newest-first so the index can serve the read; the model needs the
  // conversation the way it happened.
  const history = buildWindow(stored.reverse());

  const reply = await generateCoachReply({ routineContext, history, message });

  const answeredAt = new Date();
  await Promise.all([
    appendMessages({
      sessionId: session._id,
      userId,
      turns: [
        { role: "user", content: message, createdAt: now },
        { role: "model", content: reply, createdAt: answeredAt },
      ],
    }),
    touchSession({
      sessionId: session._id,
      lastMessageAt: answeredAt,
      added: 2,
    }),
  ]);

  return { reply, timestamp: answeredAt };
};

/**
 * A page of the athlete's transcript, oldest first so the caller can render it top to bottom.
 *
 * Paginates backwards from `before`, because a conversation is read from its end: the first page
 * is the most recent exchanges, and scrolling up asks for what came before them.
 *
 * @param {{userId: any, limit?: number, before?: Date|null}} input
 * @returns {Promise<{messages: Array<{role: string, content: string, createdAt: Date}>, hasMore: boolean}>}
 */
export const getCoachHistory = async ({ userId, limit, before = null }) => {
  const pageSize = Math.min(
    Math.max(Number(limit) || historyPageSize(), 1),
    historyPageSize(),
  );

  // Read-only: an athlete who has never chatted gets an empty page, not a new row.
  const session = await findSessionByUser(userId);
  if (!session) return { messages: [], hasMore: false };

  // One extra row answers "is there another page" without a second count query.
  const rows = await findRecentMessages({
    sessionId: session._id,
    limit: pageSize + 1,
    before,
  });

  const page = rows.slice(0, pageSize);

  return {
    messages: page.reverse(),
    hasMore: rows.length > pageSize,
  };
};
