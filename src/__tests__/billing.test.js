// Play is mocked at the service boundary, mirroring how aiChat.test.js mocks geminiService.
// Nothing here touches the real Play Developer API.
jest.mock("../services/playBillingService.js", () =>
  require("@test/mocks/playBillingService.js").create(),
);

// Pub/Sub push authenticates with an OIDC JWT in the Authorization header. Same primitive the
// app already uses for Google Sign-In, so we mock it the same way auth.test.js does.
jest.mock("google-auth-library", () =>
  require("@test/mocks/googleAuthLibrary.js").create(),
);

import User from "../models/User.js";
import {
  isBillingEnabled,
  getSubscription,
  acknowledgeSubscription,
} from "../services/playBillingService.js";
import {
  makeRtdnRequest,
  makeVerifyPurchaseRequest,
} from "@test/helpers/api.js";
import { registerTestUser } from "@test/helpers/auth.js";
import { silenceConsole } from "@test/helpers/console.js";
import { useTestDatabase } from "@test/helpers/db.js";
import {
  resetGoogleAuthMocks,
  verifyIdToken,
} from "@test/mocks/googleAuthLibrary.js";
import { resetPlayBillingMocks } from "@test/mocks/playBillingService.js";

useTestDatabase();

// The Play-outage and forged-OIDC tests log before responding.
silenceConsole();

// Matches the values globalSetup pins for the whole run.
const PUBSUB_EMAIL = process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL;
const TOKEN = "play-purchase-token-abc";
const PRODUCT_ID = "hybrid_ai_pro_monthly";
const OIDC_TOKEN = "valid-oidc-token";

const inOneMonth = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const yesterday = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

const activeSubscription = (overrides = {}) => ({
  state: "SUBSCRIPTION_STATE_ACTIVE",
  isActive: true,
  expiryTime: inOneMonth(),
  productId: PRODUCT_ID,
  orderId: "GPA.1234-5678-9012-34567",
  acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
  isAcknowledged: false,
  isTestPurchase: true,
  ...overrides,
});

const expiredSubscription = () =>
  activeSubscription({
    state: "SUBSCRIPTION_STATE_EXPIRED",
    isActive: false,
    expiryTime: yesterday(),
  });

const registerBuyer = () => registerTestUser({ name: "Buyer" });

const rtdnBody = (subscriptionNotification) => ({
  message: {
    data: Buffer.from(
      JSON.stringify({
        version: "1.0",
        packageName: "com.hybridai.training",
        eventTimeMillis: `${Date.now()}`,
        subscriptionNotification,
      }),
    ).toString("base64"),
    messageId: "msg-1",
  },
  subscription: "projects/p/subscriptions/s",
});

const givenValidPubSubToken = () => {
  verifyIdToken.mockResolvedValue({
    getPayload: () => ({ email: PUBSUB_EMAIL, email_verified: true }),
  });
};

// The global clearAllMocks only drops recorded calls. These suites queue mockResolvedValueOnce
// and install per-test defaults, both of which live in the config registry, so they need the
// stronger mockReset — followed by reinstalling the defaults reset just destroyed.
beforeEach(() => {
  resetPlayBillingMocks();
  resetGoogleAuthMocks();
  isBillingEnabled.mockReturnValue(true);
  acknowledgeSubscription.mockResolvedValue(undefined);
  givenValidPubSubToken();
});

describe("POST /api/billing/verify", () => {
  it("rejects a request with no purchaseToken", async () => {
    // Arrange
    const { token } = await registerBuyer();

    // Act
    const res = await makeVerifyPurchaseRequest(token, {});

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_TOKEN");
    expect(getSubscription).not.toHaveBeenCalled();
  });

  it("grants premium for a valid token and acknowledges it", async () => {
    // Arrange
    getSubscription.mockResolvedValue(activeSubscription());
    const { token, email } = await registerBuyer();

    // Act
    const res = await makeVerifyPurchaseRequest(token, {
      purchaseToken: TOKEN,
      productId: PRODUCT_ID,
    });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.data.is_premium).toBe(true);
    expect(res.body.data.status).toBe("premium");

    const user = await User.findOne({ email });
    expect(user.isPremium).toBe(true);
    expect(user.subscription.purchaseToken).toBe(TOKEN);
    expect(user.subscription.orderId).toBe("GPA.1234-5678-9012-34567");
    expect(user.subscription.acknowledged).toBe(true);

    expect(acknowledgeSubscription).toHaveBeenCalledWith(PRODUCT_ID, TOKEN);
  });

  // Play can answer without a productId; the client's value is the fallback, and acknowledging
  // with `undefined` would hit the wrong Play endpoint and eventually auto-refund the purchase.
  it("falls back to the client productId when Play omits it", async () => {
    // Arrange
    getSubscription.mockResolvedValue(activeSubscription({ productId: null }));
    const { token } = await registerBuyer();

    // Act
    await makeVerifyPurchaseRequest(token, {
      purchaseToken: TOKEN,
      productId: PRODUCT_ID,
    });

    // Assert
    expect(acknowledgeSubscription).toHaveBeenCalledWith(PRODUCT_ID, TOKEN);
  });

  it("does not grant anything when the subscription is not active", async () => {
    // Arrange
    getSubscription.mockResolvedValue(expiredSubscription());
    const { token, email } = await registerBuyer();

    // Act
    const res = await makeVerifyPurchaseRequest(token, {
      purchaseToken: TOKEN,
    });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SUBSCRIPTION_NOT_ACTIVE");
    expect(acknowledgeSubscription).not.toHaveBeenCalled();

    const user = await User.findOne({ email });
    expect(user.isPremium).toBe(false);
    expect(user.subscription.purchaseToken).toBeNull();
  });

  it("rejects a token already claimed by another account", async () => {
    // Arrange
    getSubscription.mockResolvedValue(activeSubscription());
    const first = await registerBuyer();
    await makeVerifyPurchaseRequest(first.token, { purchaseToken: TOKEN });
    const second = await registerBuyer();

    // Act
    const res = await makeVerifyPurchaseRequest(second.token, {
      purchaseToken: TOKEN,
    });

    // Assert
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TOKEN_ALREADY_CLAIMED");

    const secondUser = await User.findOne({ email: second.email });
    expect(secondUser.isPremium).toBe(false);
  });

  it("is idempotent - re-verifying an owned token does not acknowledge twice", async () => {
    // Arrange
    // Google reports the purchase as acknowledged once we have acknowledged it.
    getSubscription
      .mockResolvedValueOnce(activeSubscription({ isAcknowledged: false }))
      .mockResolvedValue(
        activeSubscription({
          isAcknowledged: true,
          acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
        }),
      );

    const { token, email } = await registerBuyer();
    const verify = () =>
      makeVerifyPurchaseRequest(token, { purchaseToken: TOKEN });

    // Act
    const first = await verify();
    const second = await verify(); // this is what "Restore Purchases" does

    // Assert
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(acknowledgeSubscription).toHaveBeenCalledTimes(1);

    const user = await User.findOne({ email });
    expect(user.isPremium).toBe(true);
  });

  it("returns 503 rather than granting when billing is disabled", async () => {
    // Arrange
    isBillingEnabled.mockReturnValue(false);
    const { token, email } = await registerBuyer();

    // Act
    const res = await makeVerifyPurchaseRequest(token, {
      purchaseToken: TOKEN,
    });

    // Assert
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(getSubscription).not.toHaveBeenCalled();

    const user = await User.findOne({ email });
    expect(user.isPremium).toBe(false);
  });

  it("never grants premium when Play cannot be reached", async () => {
    // Arrange
    getSubscription.mockRejectedValue(new Error("network down"));
    const { token, email } = await registerBuyer();

    // Act
    const res = await makeVerifyPurchaseRequest(token, {
      purchaseToken: TOKEN,
    });

    // Assert
    expect(res.status).toBe(502);

    const user = await User.findOne({ email });
    expect(user.isPremium).toBe(false);
  });
});

describe("POST /api/billing/rtdn", () => {
  const grantPremium = async () => {
    getSubscription.mockResolvedValue(activeSubscription());
    const buyer = await registerBuyer();
    await makeVerifyPurchaseRequest(buyer.token, { purchaseToken: TOKEN });
    getSubscription.mockReset();
    return buyer;
  };

  const notification = (overrides = {}) =>
    rtdnBody({
      notificationType: 13,
      purchaseToken: TOKEN,
      subscriptionId: PRODUCT_ID,
      ...overrides,
    });

  it("revokes premium when Play reports the subscription expired", async () => {
    // Arrange
    const { email } = await grantPremium();
    // The handler ignores notificationType and re-queries Play, which is the source of truth.
    getSubscription.mockResolvedValue(expiredSubscription());

    // Act
    const res = await makeRtdnRequest(OIDC_TOKEN, notification());

    // Assert
    expect(res.status).toBe(204);

    const user = await User.findOne({ email });
    expect(user.isPremium).toBe(false);
    expect(user.subscription.state).toBe("SUBSCRIPTION_STATE_EXPIRED");
  });

  it("is idempotent - replaying the same notification changes nothing", async () => {
    // Arrange
    const { email } = await grantPremium();
    getSubscription.mockResolvedValue(
      activeSubscription({ isAcknowledged: true }),
    );
    const send = () =>
      makeRtdnRequest(OIDC_TOKEN, notification({ notificationType: 2 }));

    // Act
    await send();
    await send();

    // Assert
    const user = await User.findOne({ email });
    expect(user.isPremium).toBe(true);
  });

  it("rejects a request without a valid Pub/Sub OIDC token", async () => {
    // Arrange
    const { email } = await grantPremium();
    verifyIdToken.mockRejectedValue(new Error("bad signature"));

    // Act
    const res = await makeRtdnRequest("forged", notification());

    // Assert
    expect(res.status).toBe(401);
    expect(getSubscription).not.toHaveBeenCalled();

    const user = await User.findOne({ email });
    expect(user.isPremium).toBe(true); // untouched
  });

  it("rejects a request with no Authorization header at all", async () => {
    // Act
    const res = await makeRtdnRequest(null, notification());

    // Assert
    expect(res.status).toBe(401);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("rejects an OIDC token minted for a different service account", async () => {
    // Arrange
    verifyIdToken.mockResolvedValue({
      getPayload: () => ({
        email: "attacker@evil.example",
        email_verified: true,
      }),
    });

    // Act
    const res = await makeRtdnRequest("other-google-client", notification());

    // Assert
    expect(res.status).toBe(401);
  });

  // An unverified address is exactly the claim an attacker controls, so it must not be trusted
  // even when the address itself matches.
  it("rejects an OIDC token whose email is not verified", async () => {
    // Arrange
    verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: PUBSUB_EMAIL, email_verified: false }),
    });

    // Act
    const res = await makeRtdnRequest(OIDC_TOKEN, notification());

    // Assert
    expect(res.status).toBe(401);
  });

  it("swallows a notification for an unknown token without retrying", async () => {
    // Act
    const res = await makeRtdnRequest(
      OIDC_TOKEN,
      notification({ notificationType: 4, purchaseToken: "never-seen" }),
    );

    // Assert
    // 2xx: a redelivery cannot fix an unknown token, and a non-2xx makes Pub/Sub loop.
    expect(res.status).toBe(204);
  });

  it("acknowledges a message carrying no subscriptionNotification", async () => {
    // Act
    const res = await makeRtdnRequest(OIDC_TOKEN, rtdnBody(undefined));

    // Assert
    expect(res.status).toBe(204);
    expect(getSubscription).not.toHaveBeenCalled();
  });

  it("acknowledges a notification with no purchaseToken", async () => {
    // Act
    const res = await makeRtdnRequest(
      OIDC_TOKEN,
      notification({ purchaseToken: undefined }),
    );

    // Assert
    expect(res.status).toBe(204);
    expect(getSubscription).not.toHaveBeenCalled();
  });

  // A 5xx here would make Pub/Sub redeliver forever against an API that is already down.
  it("answers 204, not 5xx, when Play is unreachable during an RTDN", async () => {
    // Arrange
    const { email } = await grantPremium();
    getSubscription.mockRejectedValue(new Error("play is down"));

    // Act
    const res = await makeRtdnRequest(OIDC_TOKEN, notification());

    // Assert
    expect(res.status).toBe(204);

    const user = await User.findOne({ email });
    expect(user.isPremium).toBe(true); // cached state survives the outage
  });
});
