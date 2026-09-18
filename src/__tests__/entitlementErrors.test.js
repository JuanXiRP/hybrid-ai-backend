// The three quota guards each end in `catch (error) { next(error) }`. Reaching those branches is
// not as simple as making getEntitlement reject: every guarded route stacks requireActiveAccess
// first, and resolveEntitlement memoises the result on req, so the first guard swallows the
// rejection and the later ones never call getEntitlement again.
//
// So instead of failing the call, this file shapes what it RESOLVES to — an entitlement missing
// the slice a given guard reads, which makes that guard's own destructuring throw.
//
// app.js registers no error handler, so next(error) lands in Express's default one: a 500 with
// an HTML body. Only the status is meaningful here.

jest.mock("../services/entitlementService.js", () => ({
  getEntitlement: jest.fn(),
  applyPlaySubscription: jest.fn(),
  derivePremium: jest.fn(() => false),
  getTrialEndsAt: jest.fn(() => new Date()),
  startOfUtcDay: jest.fn(() => new Date()),
  nextUtcMidnight: jest.fn(() => new Date()),
}));

jest.mock("../services/geminiService.js", () =>
  require("@test/mocks/geminiService.js").create(),
);

import { getEntitlement } from "../services/entitlementService.js";
import {
  makeAuthenticatedChatRequest,
  makeEntitlementRequest,
  makeGeneratePlanRequest,
  makeRunWorkoutRequest,
} from "@test/helpers/api.js";
import { registerTestUser } from "@test/helpers/auth.js";
import { silenceConsole } from "@test/helpers/console.js";
import { useTestDatabase } from "@test/helpers/db.js";

useTestDatabase();

// Express's default handler prints the stack to stderr.
silenceConsole();

beforeEach(() => {
  getEntitlement.mockReset();
});

describe("entitlement guards surface an unexpected failure instead of silently allowing", () => {
  it("requireActiveAccess answers 500 when the entitlement cannot be resolved", async () => {
    // Arrange
    const { token } = await registerTestUser();
    getEntitlement.mockRejectedValue(new Error("mongo is down"));

    // Act
    const res = await makeRunWorkoutRequest(token, {
      distance: 5,
      duration: 1800,
      targetPace: 330,
    });

    // Assert — a write must never be let through when the gate itself failed
    expect(res.status).toBe(500);
  });

  it("requirePlanQuota answers 500 when the entitlement has no plan counters", async () => {
    // Arrange — status is not "expired", so requireActiveAccess passes it on
    const { token } = await registerTestUser();
    getEntitlement.mockResolvedValue({ status: "trial", isPremium: false });

    // Act
    const res = await makeGeneratePlanRequest(token, {
      planDuration: 8,
      goal: "strength",
    });

    // Assert
    expect(res.status).toBe(500);
  });

  it("requireChatQuota answers 500 when the entitlement has no chat counters", async () => {
    // Arrange
    const { token } = await registerTestUser();
    getEntitlement.mockResolvedValue({ status: "trial", isPremium: false });

    // Act
    const res = await makeAuthenticatedChatRequest(token, { message: "hola" });

    // Assert
    expect(res.status).toBe(500);
  });
});

describe("GET /api/billing/entitlement", () => {
  // This route has no entitlement middleware in front of it, so its own catch block is the
  // only thing standing between a database fault and an unhandled rejection.
  it("answers 500 when the entitlement cannot be resolved", async () => {
    // Arrange
    const { token } = await registerTestUser();
    getEntitlement.mockRejectedValue(new Error("mongo is down"));

    // Act
    const res = await makeEntitlementRequest(token);

    // Assert
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
