// Purchase verification, entitlement reporting, and Real-time Developer Notifications.
//
// This is the ONLY module allowed to write isPremium / subscription / trialEndsAt. Every other
// write path uses a field allowlist (see userController) precisely so that this stays true.

import { OAuth2Client } from "google-auth-library";
import User from "../models/User.js";
import { applyPlaySubscription, getEntitlement } from "../services/entitlementService.js";
import {
  acknowledgeSubscription,
  getSubscription,
  isBillingEnabled,
} from "../services/playBillingService.js";

const pubsubClient = new OAuth2Client();

// The wire contract is snake_case (matching the Android client's @SerialName), while the
// entitlement service speaks camelCase. Translate here, at the boundary.
const toWire = (entitlement) => ({
  status: entitlement.status,
  is_premium: entitlement.isPremium,
  trial_ends_at: entitlement.trialEndsAt.toISOString(),
  trial_days_left: entitlement.trialDaysLeft,
  plans: {
    used: entitlement.plans.used,
    limit: entitlement.plans.limit,
  },
  chat: {
    used: entitlement.chat.used,
    limit: entitlement.chat.limit,
    resets_at: entitlement.chat.resetsAt.toISOString(),
  },
});

// @desc    Verify a Google Play purchase token and grant premium
// @route   POST /api/billing/verify
// @access  Private
//
// Also serves "Restore Purchases": re-verifying a token the user already owns is a no-op, so
// the client can simply replay every token from queryPurchasesAsync through this endpoint.
export const verifyPurchase = async (req, res) => {
  // Never fall back to granting premium when we cannot validate. A 503 is the correct answer.
  if (!isBillingEnabled()) {
    return res.status(503).json({
      success: false,
      code: "BILLING_DISABLED",
      message: "Billing verification is not available.",
    });
  }

  const { purchaseToken, productId } = req.body;
  if (!purchaseToken) {
    return res
      .status(400)
      .json({ success: false, code: "MISSING_TOKEN", message: "purchaseToken is required" });
  }

  try {
    // Google is the source of truth. Whatever the client claims about productId is ignored.
    const playSubscription = await getSubscription(purchaseToken);

    if (!playSubscription.isActive) {
      return res.status(400).json({
        success: false,
        code: "SUBSCRIPTION_NOT_ACTIVE",
        message: `Subscription is not active (${playSubscription.state}).`,
      });
    }

    // Replay protection: a token belongs to exactly one account.
    const existingOwner = await User.findOne({
      "subscription.purchaseToken": purchaseToken,
    }).select("_id");

    if (existingOwner && !existingOwner._id.equals(req.user._id)) {
      return res.status(409).json({
        success: false,
        code: "TOKEN_ALREADY_CLAIMED",
        message: "This purchase is already linked to another account.",
      });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(401).json({ success: false, message: "User not found" });
    }

    // Bind and persist BEFORE acknowledging, so we never acknowledge a grant we failed to store.
    user.subscription.purchaseToken = purchaseToken;
    applyPlaySubscription(user, playSubscription);
    await user.save();

    if (!playSubscription.isAcknowledged) {
      const subscriptionId = playSubscription.productId ?? productId;
      await acknowledgeSubscription(subscriptionId, purchaseToken);
      user.subscription.acknowledged = true;
      await user.save();
    }

    const entitlement = await getEntitlement(user);
    return res.status(200).json({ success: true, data: toWire(entitlement) });
  } catch (error) {
    console.error("[Billing] verifyPurchase failed:", error.message);
    return res.status(502).json({
      success: false,
      code: "PLAY_VERIFICATION_FAILED",
      message: "Could not verify the purchase with Google Play.",
    });
  }
};

// @desc    Report what the current user is allowed to do
// @route   GET /api/billing/entitlement
// @access  Private
export const getEntitlementStatus = async (req, res) => {
  try {
    const entitlement = await getEntitlement(req.user);
    return res.status(200).json({ success: true, data: toWire(entitlement) });
  } catch (error) {
    console.error("[Billing] getEntitlementStatus failed:", error.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// Pub/Sub push authenticates by signing a JWT into the Authorization header. It is NOT a
// signature over the request body, so the global express.json() is fine and no raw-body
// capture is needed. Same verification primitive as Google Sign-In in authController.
const verifyPubSubToken = async (req) => {
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) return false;

  const audience = process.env.PUBSUB_VERIFICATION_AUDIENCE;
  if (!audience) {
    // Refuse rather than skip the audience check: an undefined audience makes verifyIdToken
    // accept tokens minted for any other Google client.
    console.error("[Billing] PUBSUB_VERIFICATION_AUDIENCE is not configured");
    return false;
  }

  try {
    const ticket = await pubsubClient.verifyIdToken({
      idToken: authHeader.slice("Bearer ".length),
      audience,
    });
    const payload = ticket.getPayload();

    const expectedEmail = process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL;
    if (expectedEmail && payload.email !== expectedEmail) return false;

    return payload.email_verified === true;
  } catch (error) {
    console.error("[Billing] Pub/Sub token verification failed:", error.message);
    return false;
  }
};

// @desc    Google Play Real-time Developer Notifications
// @route   POST /api/billing/rtdn
// @access  Public, authenticated via Pub/Sub OIDC token
export const handleRtdn = async (req, res) => {
  if (!(await verifyPubSubToken(req))) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  // From here on we answer 2xx no matter what. A non-2xx makes Pub/Sub redeliver in a loop,
  // and a malformed or already-handled notification is not something a retry can fix.
  try {
    const encoded = req.body?.message?.data;
    if (!encoded) return res.status(204).end();

    const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    const notification = payload.subscriptionNotification;

    // Voided purchases, test pings and one-time-product notifications carry no subscription.
    if (!notification?.purchaseToken) return res.status(204).end();

    const { purchaseToken } = notification;

    // We deliberately ignore notificationType and re-query Play instead. The event is only a
    // trigger; Google holds the truth. This also makes the handler naturally idempotent, which
    // removes the need for a messageId dedupe store (Pub/Sub is at-least-once).
    const user = await User.findOne({ "subscription.purchaseToken": purchaseToken });
    if (!user) {
      console.warn(`[Billing] RTDN for unknown purchaseToken ${purchaseToken.slice(0, 12)}…`);
      return res.status(204).end();
    }

    const playSubscription = await getSubscription(purchaseToken);
    applyPlaySubscription(user, playSubscription);
    await user.save();

    console.log(
      `[Billing] RTDN applied: user=${user._id} state=${playSubscription.state} premium=${user.isPremium}`,
    );
    return res.status(204).end();
  } catch (error) {
    console.error("[Billing] RTDN handling failed:", error.message);
    // Still a 2xx: retrying will not help, and a stuck subscription is corrected by the lazy
    // revalidation in the entitlement middleware.
    return res.status(204).end();
  }
};
