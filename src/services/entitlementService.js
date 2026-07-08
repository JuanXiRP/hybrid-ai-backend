// The single place that answers "what is this user allowed to do right now?".
//
// Every quota is DERIVED from data that already exists rather than tracked in a counter:
//   - plans used  -> WorkoutPlan.countDocuments
//   - chat used   -> ChatHistory messages timestamped today (UTC)
//   - trial end   -> User.trialEndsAt, or createdAt + FREE_TRIAL_DAYS
// That means no reset cron, no drift between counter and reality, and nothing the client can
// manipulate. It mirrors how `has_completed_onboarding` is derived from WorkoutPlan.exists().
//
// This module returns camelCase domain objects. Translation to the snake_case wire contract
// happens in billingController, not here.

import ChatHistory from "../models/ChatHistory.js";
import WorkoutPlan from "../models/WorkoutPlan.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Read env lazily so tests can override limits per-case without re-importing the module.
const trialDays = () => Number(process.env.FREE_TRIAL_DAYS ?? 14);
const planLimit = () => Number(process.env.FREE_PLAN_LIMIT ?? 1);
const chatLimit = () => Number(process.env.FREE_CHAT_MESSAGES_PER_DAY ?? 2);

// Google keeps serving the subscription during a billing retry, so grace period still counts
// as entitled. Everything else (cancelled, expired, paused, on hold) does not.
const ENTITLED_STATES = new Set([
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
]);

export const startOfUtcDay = (now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export const nextUtcMidnight = (now = new Date()) =>
  new Date(startOfUtcDay(now).getTime() + DAY_MS);

// A null trialEndsAt means the user predates the explicit field; fall back to their signup
// date. The backfill script sets it explicitly for users who predate the freemium model.
export const getTrialEndsAt = (user) =>
  user.trialEndsAt ?? new Date(new Date(user.createdAt).getTime() + trialDays() * DAY_MS);

// The authoritative definition of "premium". `user.isPremium` is only a cached projection of
// this; never trust it without the expiry check, or a lapsed subscription stays entitled
// forever if an RTDN was missed.
export const derivePremium = (subscription, now = new Date()) =>
  Boolean(
    subscription &&
      ENTITLED_STATES.has(subscription.state) &&
      subscription.expiryTime &&
      new Date(subscription.expiryTime) > now,
  );

/**
 * Copy Google's answer onto the user document and re-derive isPremium from it.
 *
 * Shared by billingController (purchase, restore, RTDN) and entitlementMiddleware (lazy
 * revalidation) so the projection rule lives in exactly one place. Does not save.
 */
export const applyPlaySubscription = (user, playSubscription) => {
  user.subscription = {
    ...user.subscription,
    purchaseToken: user.subscription?.purchaseToken ?? null,
    productId: playSubscription.productId,
    orderId: playSubscription.orderId,
    expiryTime: playSubscription.expiryTime,
    state: playSubscription.state,
    acknowledged: playSubscription.isAcknowledged,
    lastVerifiedAt: new Date(),
  };
  user.isPremium = derivePremium(user.subscription);
  return user;
};

const countChatMessagesToday = async (userId, now) => {
  const history = await ChatHistory.findOne({ userId }).select("messages");
  if (!history) return 0;

  const since = startOfUtcDay(now);
  return history.messages.filter(
    (m) => m.role === "user" && m.timestamp && m.timestamp >= since,
  ).length;
};

/**
 * @returns {Promise<{
 *   status: 'premium' | 'trial' | 'expired',
 *   isPremium: boolean,
 *   trialEndsAt: Date,
 *   trialDaysLeft: number,
 *   plans: { used: number, limit: number | null },
 *   chat:  { used: number, limit: number | null, resetsAt: Date },
 * }>}
 */
export const getEntitlement = async (user, now = new Date()) => {
  const isPremium = derivePremium(user.subscription, now);
  const trialEndsAt = getTrialEndsAt(user);

  const status = isPremium ? "premium" : trialEndsAt > now ? "trial" : "expired";

  const [plansUsed, chatUsed] = await Promise.all([
    WorkoutPlan.countDocuments({ userId: user._id }),
    countChatMessagesToday(user._id, now),
  ]);

  return {
    status,
    isPremium,
    trialEndsAt,
    trialDaysLeft: Math.max(0, Math.ceil((trialEndsAt - now) / DAY_MS)),
    plans: {
      used: plansUsed,
      limit: isPremium ? null : planLimit(),
    },
    chat: {
      used: chatUsed,
      limit: isPremium ? null : chatLimit(),
      resetsAt: nextUtcMidnight(now),
    },
  };
};
