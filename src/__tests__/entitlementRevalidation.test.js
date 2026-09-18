// Lazy revalidation: when our cached expiryTime has lapsed, the middleware re-queries Play
// before deciding. Pub/Sub is at-least-once and a deploy that is down during a renewal simply
// misses the notification, so without this a paying user whose RTDN was lost is locked out until
// their next event.
//
// This needs BILLING_ENABLED behaviour switched on, which is exactly the invariant
// entitlement.test.js declares it will never do — hence a separate file.

jest.mock("../services/playBillingService.js", () =>
  require("@test/mocks/playBillingService.js").create(),
);

import User from "../models/User.js";
import WorkoutRun from "../models/WorkoutRun.js";
import {
  getSubscription,
  isBillingEnabled,
} from "../services/playBillingService.js";
import { makeRunWorkoutRequest } from "@test/helpers/api.js";
import { registerTestUser } from "@test/helpers/auth.js";
import { silenceConsole } from "@test/helpers/console.js";
import { useTestDatabase } from "@test/helpers/db.js";
import { resetPlayBillingMocks } from "@test/mocks/playBillingService.js";

useTestDatabase();

// The swallowed-failure test logs before falling through to cached state.
const consoleSpies = silenceConsole();

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN = "play-token-xyz";

const logRun = (token) =>
  makeRunWorkoutRequest(token, {
    distance: 5,
    duration: 1800,
    targetPace: 330,
  });

/** Seed the cached subscription state a previous verification would have written. */
const givenCachedSubscription = (
  email,
  { expiryTime, purchaseToken = TOKEN },
) =>
  User.updateOne(
    { email },
    {
      $set: {
        "subscription.purchaseToken": purchaseToken,
        "subscription.productId": "hybrid_ai_pro_monthly",
        "subscription.state": "SUBSCRIPTION_STATE_ACTIVE",
        "subscription.expiryTime": expiryTime,
        isPremium: false,
      },
    },
  );

const expireTrial = (email) =>
  User.updateOne(
    { email },
    { $set: { trialEndsAt: new Date(Date.now() - DAY_MS) } },
  );

const playSaysActive = () => ({
  state: "SUBSCRIPTION_STATE_ACTIVE",
  isActive: true,
  expiryTime: new Date(Date.now() + 30 * DAY_MS),
  productId: "hybrid_ai_pro_monthly",
  orderId: "GPA.1",
  acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
  isAcknowledged: true,
  isTestPurchase: false,
});

beforeEach(() => {
  resetPlayBillingMocks();
  isBillingEnabled.mockReturnValue(true);
});

describe("revalidateIfLapsed — when it stays quiet", () => {
  it("does not call Play for a user who never bought anything", async () => {
    // Arrange
    const { token } = await registerTestUser();

    // Act
    await logRun(token);

    // Assert
    expect(getSubscription).not.toHaveBeenCalled();
  });

  it("does not call Play while the cached expiry is still in the future", async () => {
    // Arrange
    const { token, email } = await registerTestUser();
    await givenCachedSubscription(email, {
      expiryTime: new Date(Date.now() + DAY_MS),
    });

    // Act
    await logRun(token);

    // Assert — the common case must cost nothing
    expect(getSubscription).not.toHaveBeenCalled();
  });

  it("does not call Play when billing is switched off", async () => {
    // Arrange
    isBillingEnabled.mockReturnValue(false);
    const { token, email } = await registerTestUser();
    await givenCachedSubscription(email, {
      expiryTime: new Date(Date.now() - DAY_MS),
    });

    // Act
    await logRun(token);

    // Assert
    expect(getSubscription).not.toHaveBeenCalled();
  });
});

describe("revalidateIfLapsed — when it fires", () => {
  it("restores premium for a user whose renewal notification was lost", async () => {
    // Arrange — trial over and cached subscription lapsed: without revalidation this is a 402
    const { token, email } = await registerTestUser();
    await givenCachedSubscription(email, {
      expiryTime: new Date(Date.now() - DAY_MS),
    });
    await expireTrial(email);
    getSubscription.mockResolvedValue(playSaysActive());

    // Act
    const res = await logRun(token);

    // Assert
    expect(getSubscription).toHaveBeenCalledWith(TOKEN);
    expect(res.status).toBe(201);

    // The refreshed state is persisted, so the next request does not have to ask Play again.
    const user = await User.findOne({ email });
    expect(user.isPremium).toBe(true);
    expect(new Date(user.subscription.expiryTime).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it("revalidates when the cached subscription has no expiry recorded at all", async () => {
    // Arrange
    const { token, email } = await registerTestUser();
    await givenCachedSubscription(email, { expiryTime: null });
    getSubscription.mockResolvedValue(playSaysActive());

    // Act
    await logRun(token);

    // Assert
    expect(getSubscription).toHaveBeenCalledWith(TOKEN);
  });

  it("keeps the cached state, and never 500s, when Play cannot be reached", async () => {
    // Arrange
    const { token, email } = await registerTestUser();
    await givenCachedSubscription(email, {
      expiryTime: new Date(Date.now() - DAY_MS),
    });
    await expireTrial(email);
    getSubscription.mockRejectedValue(new Error("play is down"));

    // Act
    const res = await logRun(token);

    // Assert — falls through to the cached answer rather than failing the request
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("TRIAL_EXPIRED");
    expect(consoleSpies.error).toHaveBeenCalledWith(
      expect.stringContaining("Lazy revalidation failed"),
      expect.any(String),
    );

    const user = await User.findOne({ email });
    expect(user.isPremium).toBe(false);
    expect(await WorkoutRun.countDocuments()).toBe(0);
  });

  // Both guards on a route share one resolved entitlement, so the Play round-trip must not be
  // paid twice for a single request.
  it("queries Play at most once per request", async () => {
    // Arrange
    const { token, email } = await registerTestUser();
    await givenCachedSubscription(email, {
      expiryTime: new Date(Date.now() - DAY_MS),
    });
    getSubscription.mockResolvedValue(playSaysActive());

    // Act
    await logRun(token);

    // Assert
    expect(getSubscription).toHaveBeenCalledTimes(1);
  });
});
