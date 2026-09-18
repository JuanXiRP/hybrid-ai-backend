import { randomUUID } from "crypto";
import User from "../models/User.js";
import {
  makeCreateUserRequest,
  makeGetProfileRequest,
  makeUpdateProfileRequest,
} from "@test/helpers/api.js";
import { registerTestUser } from "@test/helpers/auth.js";
import { useTestDatabase } from "@test/helpers/db.js";

useTestDatabase();

const fullProfile = {
  age: 30,
  weight: 60,
  height: 165,
  sex: "female",
  goal: "both",
  fitnessLevel: "intermediate",
  daysAvailable: 4,
  planDuration: 8,
};

describe("PATCH /api/users/profile — last_period_date", () => {
  it("persists a valid last_period_date and returns it in snake_case", async () => {
    // Arrange
    const { token } = await registerTestUser({ name: "Ada" });

    // Act
    const res = await makeUpdateProfileRequest(token, {
      ...fullProfile,
      last_period_date: "2026-07-01",
    });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.data.last_period_date).toBe("2026-07-01");

    // Round-trips through GET without format drift
    const getRes = await makeGetProfileRequest(token);
    expect(getRes.body.data.last_period_date).toBe("2026-07-01");
  });

  it("accepts a profile update without last_period_date (stays null)", async () => {
    // Arrange
    const { token } = await registerTestUser({ name: "Ada" });

    // Act
    const res = await makeUpdateProfileRequest(token, { ...fullProfile });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.data.last_period_date ?? null).toBeNull();
  });

  it("rejects a future last_period_date", async () => {
    // Arrange
    const { token } = await registerTestUser({ name: "Ada" });

    // Act
    const res = await makeUpdateProfileRequest(token, {
      ...fullProfile,
      last_period_date: "2999-01-01",
    });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("rejects a malformed last_period_date", async () => {
    // Arrange
    const { token } = await registerTestUser({ name: "Ada" });

    // Act
    const res = await makeUpdateProfileRequest(token, {
      ...fullProfile,
      last_period_date: "01/07/2026",
    });

    // Assert
    expect(res.status).toBe(400);
  });

  it("rejects an impossible calendar date", async () => {
    // Arrange
    const { token } = await registerTestUser({ name: "Ada" });

    // Act
    const res = await makeUpdateProfileRequest(token, {
      ...fullProfile,
      last_period_date: "2026-02-30",
    });

    // Assert
    expect(res.status).toBe(400);
  });
});

// Entitlement fields (isPremium, trialEndsAt, subscription) are owned exclusively by
// billingController. Both write paths into User used to spread req.body, which made every
// one of those fields client-writable — a trivial privilege escalation once premium gates
// anything. These tests pin the allowlists shut.
describe("mass assignment — entitlement fields are not client-writable", () => {
  it("ignores isPremium in PATCH /api/users/profile", async () => {
    // Arrange
    const { token, email } = await registerTestUser({ name: "Ada" });

    // Act
    const res = await makeUpdateProfileRequest(token, {
      ...fullProfile,
      isPremium: true,
    });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.data.isPremium).toBe(false);

    // The database, not just the response body, must be unchanged.
    const user = await User.findOne({ email });
    expect(user.isPremium).toBe(false);
  });

  it("ignores trialEndsAt and subscription in PATCH /api/users/profile", async () => {
    // Arrange
    const { token, email } = await registerTestUser({ name: "Ada" });
    const farFuture = "2999-01-01T00:00:00.000Z";

    // Act
    await makeUpdateProfileRequest(token, {
      ...fullProfile,
      trialEndsAt: farFuture,
      subscription: {
        purchaseToken: "forged",
        state: "SUBSCRIPTION_STATE_ACTIVE",
      },
    });

    // Assert
    const user = await User.findOne({ email });
    expect(user.trialEndsAt ?? null).toBeNull();
    expect(user.subscription?.purchaseToken ?? null).toBeNull();
  });

  it("ignores isPremium in POST /api/users", async () => {
    // Arrange
    const email = `grace-${randomUUID()}@example.test`;

    // Act
    const res = await makeCreateUserRequest({
      name: "Grace",
      email,
      password: "password123",
      isPremium: true,
    });

    // Assert
    expect(res.status).toBe(201);

    const user = await User.findOne({ email });
    expect(user.isPremium).toBe(false);
  });

  it("still persists the legitimate onboarding fields", async () => {
    // Arrange
    const { token } = await registerTestUser({ name: "Ada" });

    // Act
    const res = await makeUpdateProfileRequest(token, {
      ...fullProfile,
      isPremium: true,
    });

    // Assert
    expect(res.body.data.age).toBe(30);
    expect(res.body.data.goal).toBe("both");
    expect(res.body.data.planDuration).toBe(8);
    expect(res.body.data.hasCompletedOnboarding).toBe(true);
  });
});
