// Read-side database access for the athlete's training data, used by the coach hydrator.
//
// Writes still belong to the workout controllers; this file exists so the chat path can ask
// "what is this athlete doing, and what have they actually done" without importing three models
// and re-deriving the right query each time.

import WorkoutPlan from "../models/WorkoutPlan.js";
import WorkoutRun from "../models/WorkoutRun.js";
import WorkoutStrength from "../models/WorkoutStrength.js";

/**
 * The athlete's current macrocycle, or null.
 *
 * Same shape as the query behind `GET /api/plans/active`: the `active` filter hits the
 * { userId, active } compound index, and the createdAt sort is what actually picks the newest —
 * nothing in the app clears `active` today, so every plan a user has is still flagged active.
 *
 * @param {any} userId
 * @returns {Promise<object|null>}
 */
export const findActivePlan = (userId) =>
  WorkoutPlan.findOne({ userId, active: true }).sort({ createdAt: -1 }).lean();

/**
 * Completed strength sessions since `since`, newest first.
 *
 * @param {any} userId
 * @param {Date} since
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
export const findRecentStrengthSessions = (userId, since, limit) =>
  WorkoutStrength.find({ userId, date: { $gte: since } })
    .sort({ date: -1 })
    .limit(limit)
    .lean();

/**
 * Completed runs since `since`, newest first.
 *
 * `gpsPath` is excluded deliberately: a tracked run holds thousands of coordinate pairs, and the
 * coach summarises a run in one line. Loading the trace would turn a 4 KB read into a 400 KB one
 * on the chat hot path, for data no prompt will ever contain.
 *
 * @param {any} userId
 * @param {Date} since
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
export const findRecentRunSessions = (userId, since, limit) =>
  WorkoutRun.find({ userId, date: { $gte: since } })
    .sort({ date: -1 })
    .limit(limit)
    .select("-gpsPath")
    .lean();
