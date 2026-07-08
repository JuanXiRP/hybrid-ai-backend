// Free-tier gates. Each returns 402 Payment Required with a machine-readable `code` so the
// Android client knows which bottom sheet to open, rather than guessing from a message string.
//
// Must run after `protect`, which hydrates req.user.

import { applyPlaySubscription, getEntitlement } from "../services/entitlementService.js";
import { getSubscription, isBillingEnabled } from "../services/playBillingService.js";

const paymentRequired = (res, code, message, data = {}) =>
  res.status(402).json({ success: false, code, message, data });

/**
 * Re-query Google when our cached expiryTime has lapsed.
 *
 * Pub/Sub guarantees at-least-once, not exactly-once, and a deploy that is down during a
 * renewal simply misses the notification. Without this, a paying user whose RTDN was lost gets
 * locked out until their next event. Only fires past expiry, so it costs nothing in the common
 * case. Failures here are swallowed: we fall through to the cached state rather than 500ing.
 */
const revalidateIfLapsed = async (user) => {
  const token = user.subscription?.purchaseToken;
  if (!token || !isBillingEnabled()) return;

  const expiry = user.subscription.expiryTime;
  if (expiry && new Date(expiry) > new Date()) return; // still fresh

  try {
    const playSubscription = await getSubscription(token);
    applyPlaySubscription(user, playSubscription);
    await user.save();
  } catch (error) {
    console.error("[Entitlement] Lazy revalidation failed:", error.message);
  }
};

// Resolves the entitlement once per request and memoises it on req, so stacked guards
// (requireActiveAccess + requireChatQuota) do not each hit the database.
const resolveEntitlement = async (req) => {
  if (!req.entitlement) {
    await revalidateIfLapsed(req.user);
    req.entitlement = await getEntitlement(req.user);
  }
  return req.entitlement;
};

/**
 * Blocks every write once the free trial has run out. Read routes stay open — an expired user
 * keeps their plan and history, they just cannot create anything new.
 */
export const requireActiveAccess = async (req, res, next) => {
  try {
    const entitlement = await resolveEntitlement(req);
    if (entitlement.status !== "expired") return next();

    return paymentRequired(
      res,
      "TRIAL_EXPIRED",
      "Your free trial has ended. Subscribe to keep training.",
      { trial_ends_at: entitlement.trialEndsAt.toISOString() },
    );
  } catch (error) {
    return next(error);
  }
};

/** Free users get FREE_PLAN_LIMIT generated plans in total (the onboarding one). */
export const requirePlanQuota = async (req, res, next) => {
  try {
    const { isPremium, plans } = await resolveEntitlement(req);
    if (isPremium || plans.used < plans.limit) return next();

    return paymentRequired(
      res,
      "PLAN_LIMIT_REACHED",
      "Your free plan includes one generated routine.",
      { used: plans.used, limit: plans.limit },
    );
  } catch (error) {
    return next(error);
  }
};

/** Free users get FREE_CHAT_MESSAGES_PER_DAY coach messages, resetting at UTC midnight. */
export const requireChatQuota = async (req, res, next) => {
  try {
    const { isPremium, chat } = await resolveEntitlement(req);
    if (isPremium || chat.used < chat.limit) return next();

    return paymentRequired(
      res,
      "CHAT_QUOTA_EXCEEDED",
      "You have used today's coach messages.",
      { used: chat.used, limit: chat.limit, resets_at: chat.resetsAt.toISOString() },
    );
  } catch (error) {
    return next(error);
  }
};
