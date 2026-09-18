// Free tier: 1 generated plan, 2 coach messages per UTC day, 14-day usage window, then
// read-only. Everything is derived from existing data, so these tests drive the real code
// paths (WorkoutPlan counts, ChatHistory timestamps, User.createdAt) rather than a counter.

jest.mock("../services/geminiService.js", () =>
  require("@test/mocks/geminiService.js").create(),
);

// Billing stays disabled here: no test in this file should reach the Play API, and lazy
// revalidation must short-circuit rather than throw. The revalidation path itself, which needs
// billing switched on, is covered by entitlementRevalidation.test.js.
jest.mock("../services/playBillingService.js", () =>
  require("@test/mocks/playBillingService.js").create(),
);

import ChatHistory from "../models/ChatHistory.js";
import User from "../models/User.js";
import WorkoutPlan from "../models/WorkoutPlan.js";
import WorkoutRun from "../models/WorkoutRun.js";
import {
  generateWorkoutPlan,
  processChatMessage,
} from "../services/geminiService.js";
import { isBillingEnabled } from "../services/playBillingService.js";
import {
  makeAuthenticatedChatRequest,
  makeEntitlementRequest,
  makeGeneratePlanRequest,
  makeGetActivePlanRequest,
  makeGetPlanHistoryRequest,
  makeGetProfileRequest,
  makeRunWorkoutRequest,
} from "@test/helpers/api.js";
import { registerTestUser } from "@test/helpers/auth.js";
import { useTestDatabase } from "@test/helpers/db.js";
import { resetGeminiMocks } from "@test/mocks/geminiService.js";
import { resetPlayBillingMocks } from "@test/mocks/playBillingService.js";

useTestDatabase();

const DAY_MS = 24 * 60 * 60 * 1000;

const registerFreeUser = () => registerTestUser({ name: "Free User" });

const generatePlan = (token) =>
  makeGeneratePlanRequest(token, { planDuration: 8, goal: "strength" });

const sendChat = (token, message = "hola") =>
  makeAuthenticatedChatRequest(token, { message });

// A payload the controller would happily accept, so that a 402 proves the middleware blocked
// the write rather than the model rejecting it (targetPace is required).
const logRun = (token) =>
  makeRunWorkoutRequest(token, {
    distance: 5,
    duration: 1800,
    targetPace: 330,
  });

/** Make the user premium the way billingController would: an active, unexpired subscription. */
const makePremium = async (email) => {
  const user = await User.findOne({ email });
  user.subscription = {
    purchaseToken: `tok-${email}`,
    productId: "hybrid_ai_pro_monthly",
    orderId: "GPA.1",
    expiryTime: new Date(Date.now() + 30 * DAY_MS),
    state: "SUBSCRIPTION_STATE_ACTIVE",
    acknowledged: true,
    lastVerifiedAt: new Date(),
  };
  user.isPremium = true;
  await user.save();
};

const expireTrial = async (email) => {
  await User.updateOne(
    { email },
    { $set: { trialEndsAt: new Date(Date.now() - DAY_MS) } },
  );
};

// Defensive: nothing in this file asserts on mock call counts today, but reinstating the
// defaults per test keeps it that way by construction rather than by luck.
beforeEach(() => {
  resetGeminiMocks();
  generateWorkoutPlan.mockResolvedValue(JSON.stringify({ weeks: [] }));
  processChatMessage.mockResolvedValue("AI reply");
  resetPlayBillingMocks();
  isBillingEnabled.mockReturnValue(false);
});

describe("plan quota", () => {
  it("lets a free user generate their onboarding plan", async () => {
    // Arrange
    const { token } = await registerFreeUser();

    // Act
    const res = await generatePlan(token);

    // Assert
    expect(res.status).toBe(201);
  });

  it("blocks the second plan with PLAN_LIMIT_REACHED", async () => {
    // Arrange
    const { token } = await registerFreeUser();
    expect((await generatePlan(token)).status).toBe(201);

    // Act
    const res = await generatePlan(token);

    // Assert
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("PLAN_LIMIT_REACHED");
    expect(res.body.data).toEqual({ used: 1, limit: 1 });
    expect(await WorkoutPlan.countDocuments()).toBe(1);
  });

  it("lets a premium user regenerate without limit", async () => {
    // Arrange
    const { token, email } = await registerFreeUser();
    await makePremium(email);

    // Act
    const first = await generatePlan(token);
    const second = await generatePlan(token);

    // Assert
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await WorkoutPlan.countDocuments()).toBe(2);
  });
});

describe("chat quota", () => {
  it("allows exactly two coach messages per day, then 402s", async () => {
    // Arrange
    const { token } = await registerFreeUser();
    expect((await sendChat(token, "one")).status).toBe(200);
    expect((await sendChat(token, "two")).status).toBe(200);

    // Act
    const res = await sendChat(token, "three");

    // Assert
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("CHAT_QUOTA_EXCEEDED");
    expect(res.body.data.used).toBe(2);
    expect(res.body.data.limit).toBe(2);
    expect(new Date(res.body.data.resets_at).getTime()).toBeGreaterThan(
      Date.now(),
    );

    // The blocked message never reached Gemini nor the durable log.
    const history = await ChatHistory.findOne();
    expect(history.messages.filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("resets once the messages fall before the current UTC day", async () => {
    // Arrange
    const { token } = await registerFreeUser();
    await sendChat(token, "one");
    await sendChat(token, "two");
    expect((await sendChat(token, "three")).status).toBe(402);

    // Backdate yesterday's conversation; the quota counts only today's user turns.
    const history = await ChatHistory.findOne();
    history.messages.forEach((m) => {
      m.timestamp = new Date(Date.now() - 2 * DAY_MS);
    });
    await history.save();

    // Act
    const res = await sendChat(token, "fresh day");

    // Assert
    expect(res.status).toBe(200);
  });

  it("does not limit a premium user", async () => {
    // Arrange
    const { token, email } = await registerFreeUser();
    await makePremium(email);

    // Act + Assert
    for (const text of ["a", "b", "c", "d"]) {
      expect((await sendChat(token, text)).status).toBe(200);
    }
  });
});

describe("trial window", () => {
  it("blocks writes but keeps reads once the trial expires", async () => {
    // Arrange
    const { token, email } = await registerFreeUser();

    // Seed a plan while still inside the trial, and prove the run payload is otherwise
    // acceptable - otherwise the 402 below could be a validation 400 in disguise.
    expect((await generatePlan(token)).status).toBe(201);
    expect((await logRun(token)).status).toBe(201);
    await WorkoutRun.deleteMany();

    await expireTrial(email);

    // Act
    const write = await logRun(token);
    const chat = await sendChat(token);
    const read = await makeGetActivePlanRequest(token);
    const history = await makeGetPlanHistoryRequest(token);

    // Assert
    expect(write.status).toBe(402);
    expect(write.body.code).toBe("TRIAL_EXPIRED");
    expect(await WorkoutRun.countDocuments()).toBe(0);

    expect(chat.status).toBe(402);
    expect(chat.body.code).toBe("TRIAL_EXPIRED");

    // Read-only: the user keeps their plan and history.
    expect(read.status).toBe(200);
    expect(history.status).toBe(200);
  });

  it("lifts the expiry for a premium user", async () => {
    // Arrange
    const { token, email } = await registerFreeUser();
    await expireTrial(email);
    await makePremium(email);

    // Act
    const run = await logRun(token);
    const chat = await sendChat(token);

    // Assert
    expect(run.status).toBe(201);
    expect(chat.status).toBe(200);
  });

  it("still lets an expired user read their profile", async () => {
    // Arrange
    const { token, email } = await registerFreeUser();
    await expireTrial(email);

    // Act
    const res = await makeGetProfileRequest(token);

    // Assert
    expect(res.status).toBe(200);
  });
});

describe("GET /api/billing/entitlement", () => {
  it("reports the free-tier state a client needs to render counters", async () => {
    // Arrange
    const { token } = await registerFreeUser();
    await sendChat(token, "one");

    // Act
    const res = await makeEntitlementRequest(token);

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: "trial",
      is_premium: false,
      plans: { used: 0, limit: 1 },
      chat: { used: 1, limit: 2 },
    });
    expect(res.body.data.trial_days_left).toBe(14);
    expect(typeof res.body.data.trial_ends_at).toBe("string");
    expect(typeof res.body.data.chat.resets_at).toBe("string");
  });

  it("reports premium with no limits", async () => {
    // Arrange
    const { token, email } = await registerFreeUser();
    await makePremium(email);

    // Act
    const res = await makeEntitlementRequest(token);

    // Assert
    expect(res.body.data.status).toBe("premium");
    expect(res.body.data.is_premium).toBe(true);
    expect(res.body.data.plans.limit).toBeNull();
    expect(res.body.data.chat.limit).toBeNull();
  });

  it("reports expired once the trial window closes", async () => {
    // Arrange
    const { token, email } = await registerFreeUser();
    await expireTrial(email);

    // Act
    const res = await makeEntitlementRequest(token);

    // Assert
    expect(res.body.data.status).toBe("expired");
    expect(res.body.data.trial_days_left).toBe(0);
  });
});
