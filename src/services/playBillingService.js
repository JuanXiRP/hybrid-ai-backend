// The only place that talks to the Google Play Developer API, mirroring how geminiService.js
// is the only place that talks to Gemini. Tests mock this module, not the HTTP layer.
//
// We deliberately do NOT depend on `googleapis` (~50MB) for two REST calls. google-auth-library
// is already a dependency (it verifies Google Sign-In tokens) and can mint the service-account
// access token on its own.

import { GoogleAuth } from "google-auth-library";

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const BASE_URL = "https://androidpublisher.googleapis.com/androidpublisher/v3";

// Google keeps serving a subscription while a renewal payment is being retried, so grace
// period is still entitled. Kept in sync with ENTITLED_STATES in entitlementService.
const ENTITLED_STATES = new Set([
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
]);

export class PlayBillingError extends Error {
  constructor(message, { status = null, cause = null } = {}) {
    super(message);
    this.name = "PlayBillingError";
    this.status = status;
    this.cause = cause;
  }
}

export const isBillingEnabled = () => process.env.BILLING_ENABLED === "true";

const packageName = () => {
  const name = process.env.PLAY_PACKAGE_NAME;
  if (!name) {
    throw new PlayBillingError("PLAY_PACKAGE_NAME is not configured");
  }
  return name;
};

let cachedAuth = null;

// The key is passed base64-encoded because a raw JSON blob in an env var mangles the private
// key's newlines on most hosts (Render included). Decoding from base64 sidesteps that.
const getAuth = () => {
  if (cachedAuth) return cachedAuth;

  const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!encoded) {
    throw new PlayBillingError("GOOGLE_SERVICE_ACCOUNT_JSON is not configured");
  }

  let credentials;
  try {
    credentials = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch (error) {
    throw new PlayBillingError(
      "GOOGLE_SERVICE_ACCOUNT_JSON is not valid base64-encoded JSON",
      { cause: error },
    );
  }

  cachedAuth = new GoogleAuth({ credentials, scopes: [SCOPE] });
  return cachedAuth;
};

// Exposed for tests, which swap env vars between cases.
export const resetAuthCache = () => {
  cachedAuth = null;
};

const request = async (url, method = "GET") => {
  try {
    const client = await getAuth().getClient();
    const response = await client.request({ url, method });
    return response.data;
  } catch (error) {
    if (error instanceof PlayBillingError) throw error;

    const status = error?.response?.status ?? null;
    throw new PlayBillingError(
      `Play Developer API ${method} failed${status ? ` (HTTP ${status})` : ""}: ${error.message}`,
      { status, cause: error },
    );
  }
};

/**
 * purchases.subscriptionsv2.get — the source of truth for a subscription's state.
 *
 * Note `expiryTime` lives on the line item, not the top level. A subscription has exactly one
 * line item in our single-product setup; upgrade/downgrade flows would add `linkedPurchaseToken`
 * handling, which we do not support yet.
 */
export const getSubscription = async (purchaseToken) => {
  const url = `${BASE_URL}/applications/${packageName()}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
  const data = await request(url);

  const lineItem = data.lineItems?.[0] ?? {};
  const expiryTime = lineItem.expiryTime ? new Date(lineItem.expiryTime) : null;
  const state = data.subscriptionState ?? null;

  return {
    state,
    isActive:
      ENTITLED_STATES.has(state) && Boolean(expiryTime) && expiryTime > new Date(),
    expiryTime,
    productId: lineItem.productId ?? null,
    orderId: data.latestOrderId ?? null,
    acknowledgementState: data.acknowledgementState ?? null,
    isAcknowledged:
      data.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    isTestPurchase: Boolean(data.testPurchase),
  };
};

/**
 * purchases.subscriptions.acknowledge — note this is the v1 endpoint. subscriptionsv2 exposes
 * no acknowledge method.
 *
 * If nobody acknowledges within three days Google automatically refunds the purchase, so this
 * must run once the entitlement has been persisted (and not before, or we could acknowledge a
 * grant we then failed to store).
 */
export const acknowledgeSubscription = async (subscriptionId, purchaseToken) => {
  const url = `${BASE_URL}/applications/${packageName()}/purchases/subscriptions/${encodeURIComponent(subscriptionId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
  await request(url, "POST");
};
