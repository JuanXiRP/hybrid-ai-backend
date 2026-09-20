// All database access for the coach conversation, and the only place that knows ChatSession and
// ChatMessage exist.
//
// Every export below is a single query that returns plain objects (`.lean()`), so no Mongoose
// document — and therefore no accidental `.save()` and no lazily-populated virtual — ever reaches
// a service. Domain rules live above this layer: which turns fit a prompt, what a page is, when
// to persist. This file only knows how to read and write rows.

import ChatMessage from "../models/ChatMessage.js";
import ChatSession from "../models/ChatSession.js";

/**
 * @typedef {Object} ChatSessionRecord
 * @property {import('mongoose').Types.ObjectId} _id
 * @property {import('mongoose').Types.ObjectId} userId
 * @property {Date} lastMessageAt
 * @property {number} messageCount
 *
 * @typedef {Object} ChatMessageRecord
 * @property {import('mongoose').Types.ObjectId} _id
 * @property {'user'|'model'} role
 * @property {string} content
 * @property {Date} createdAt
 */

const DUPLICATE_KEY = 11000;

/**
 * The user's conversation, created on first use.
 *
 * An upsert rather than findOne-then-create because two requests can arrive together: without it
 * both would read "no session" and both would insert. The unique index on `userId` is what makes
 * the race safe, and the duplicate-key branch below is the loser of that race re-reading the
 * winner's document instead of failing the request.
 *
 * @param {import('mongoose').Types.ObjectId} userId
 * @param {Date} [now]
 * @returns {Promise<ChatSessionRecord>}
 */
export const getOrCreateSession = async (userId, now = new Date()) => {
  try {
    return await ChatSession.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId, lastMessageAt: now, messageCount: 0 } },
      { upsert: true, new: true },
    ).lean();
  } catch (error) {
    if (error?.code !== DUPLICATE_KEY) throw error;
    return ChatSession.findOne({ userId }).lean();
  }
};

/**
 * The user's conversation if it exists, without creating one.
 *
 * Used by the read path: a GET must not leave a row behind for an athlete who has never chatted.
 *
 * @param {any} userId
 * @returns {Promise<ChatSessionRecord|null>}
 */
export const findSessionByUser = (userId) =>
  ChatSession.findOne({ userId }).lean();

/**
 * Conversation turns, NEWEST FIRST — the caller reverses for the model.
 *
 * Descending sort plus a limit is what lets `{ sessionId, createdAt, _id }` serve the read
 * without touching the rest of the thread, which is the entire reason messages are rows rather
 * than an array on the session. `before` makes the same query paginate backwards for the history
 * endpoint, so the window and the page share one code path and one index.
 *
 * @param {{sessionId: any, limit: number, before?: Date|null}} params
 * @returns {Promise<ChatMessageRecord[]>}
 */
export const findRecentMessages = ({ sessionId, limit, before = null }) =>
  ChatMessage.find(
    before ? { sessionId, createdAt: { $lt: before } } : { sessionId },
  )
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .select("role content createdAt")
    .lean();

/**
 * Append a whole exchange in one round trip.
 *
 * Schema validation stays on (the role enum, the required content), which is what stops an empty
 * model reply from being persisted as a turn the next prompt would have to carry.
 *
 * @param {{sessionId: any, userId: any, turns: Array<{role: 'user'|'model', content: string, createdAt: Date}>}} params
 * @returns {Promise<ChatMessageRecord[]>}
 */
export const appendMessages = async ({ sessionId, userId, turns }) => {
  const created = await ChatMessage.insertMany(
    turns.map((turn) => ({ ...turn, sessionId, userId })),
  );
  return created.map((document) => document.toObject());
};

/**
 * Keep the session's denormalised cursor in step with its messages.
 *
 * @param {{sessionId: any, lastMessageAt: Date, added: number}} params
 * @returns {Promise<void>}
 */
export const touchSession = async ({ sessionId, lastMessageAt, added }) => {
  await ChatSession.updateOne(
    { _id: sessionId },
    { $set: { lastMessageAt }, $inc: { messageCount: added } },
  );
};

/**
 * The ONE definition of "how many coach messages has this user sent since X".
 *
 * entitlementService calls this instead of reading the collection itself, so the freemium quota
 * and the index that answers it stay in the same place. Counts user turns only: a model reply is
 * not something the athlete spends.
 *
 * @param {any} userId
 * @param {Date} since
 * @returns {Promise<number>}
 */
export const countUserMessagesSince = (userId, since) =>
  ChatMessage.countDocuments({
    userId,
    role: "user",
    createdAt: { $gte: since },
  });
