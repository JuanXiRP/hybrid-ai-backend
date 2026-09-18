// The shared factory exposes verifyIdToken as a bare jest.fn(), so each test installs the Google
// payload it needs. The copy this replaces baked a fixed payload into a closure, which is why
// every Google test had to share one hard-coded address.
jest.mock("google-auth-library", () =>
  require("@test/mocks/googleAuthLibrary.js").create(),
);

import { randomUUID } from "crypto";
import User from "../models/User.js";
import WorkoutPlan from "../models/WorkoutPlan.js";
import {
  makeGoogleLoginRequest,
  makeLoginRequest,
  makeRegisterRequest,
} from "@test/helpers/api.js";
import { registerTestUser } from "@test/helpers/auth.js";
import { useTestDatabase } from "@test/helpers/db.js";
import {
  givenGoogleUser,
  resetGoogleAuthMocks,
} from "@test/mocks/googleAuthLibrary.js";

useTestDatabase();

const GOOGLE_SUB = "google-123";
const uniqueEmail = (prefix) => `${prefix}-${randomUUID()}@example.test`;

beforeEach(() => {
  resetGoogleAuthMocks();
});

// ==================== REGISTER ====================
describe("POST /api/auth/register", () => {
  it("registers a new user and returns a token", async () => {
    // Arrange
    const email = uniqueEmail("register");

    // Act
    const res = await makeRegisterRequest({
      name: "Test",
      email,
      password: "password123",
    });

    // Assert
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
  });

  it("rejects duplicate email", async () => {
    // Arrange — the address only has to collide with itself, so reuse the generated one
    const { email } = await registerTestUser({ name: "First" });

    // Act
    const res = await makeRegisterRequest({
      name: "Second",
      email,
      password: "password123",
    });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ==================== LOGIN + ONBOARDING FLAG ====================
describe("POST /api/auth/login", () => {
  it("returns has_completed_onboarding: false when user has NO plan", async () => {
    // Arrange
    const { email, password } = await registerTestUser({ name: "Test" });

    // Act
    const res = await makeLoginRequest({ email, password });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.body.has_completed_onboarding).toBe(false);
  });

  it("returns has_completed_onboarding: true when user HAS a plan", async () => {
    // Arrange
    const { email, password } = await registerTestUser({ name: "Test" });
    const user = await User.findOne({ email });
    await WorkoutPlan.create({
      userId: user._id,
      durationWeeks: 8,
      goal: "strength",
      weeks: [],
    });

    // Act
    const res = await makeLoginRequest({ email, password });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.has_completed_onboarding).toBe(true);
  });

  it("rejects wrong password", async () => {
    // Arrange
    const { email } = await registerTestUser({ name: "Test" });

    // Act
    const res = await makeLoginRequest({ email, password: "wrongpassword" });

    // Assert
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects an unknown email without revealing more than "invalid credentials"', async () => {
    // Arrange — deliberately never registered
    const email = uniqueEmail("nobody");

    // Act
    const res = await makeLoginRequest({ email, password: "password123" });

    // Assert
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid credentials");
  });

  // Regression: a Google-only account has no password, and bcrypt.compare throws on an undefined
  // hash. That throw used to escape as a 500, leaving the user with no way in at all —
  // registering answered "already exists" and logging in crashed.
  it("answers 401 with actionable copy for a Google-only account, never a 500", async () => {
    // Arrange
    const email = uniqueEmail("google-only");
    givenGoogleUser({ sub: GOOGLE_SUB, email });
    await makeGoogleLoginRequest({ idToken: "fake-google-token" });

    // Act
    const res = await makeLoginRequest({ email, password: "anything" });

    // Assert
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/Google Sign-In/);
  });
});

describe("User.matchPassword", () => {
  it("returns false instead of throwing when the account has no password", async () => {
    // Arrange
    const user = await User.create({
      name: "Google Only",
      email: uniqueEmail("nopassword"),
      googleId: "google-999",
    });

    // Act + Assert
    await expect(user.matchPassword("anything")).resolves.toBe(false);
  });

  it("still compares correctly when a password is present", async () => {
    // Arrange
    const email = uniqueEmail("haspassword");
    await User.create({
      name: "With Password",
      email,
      password: "password123",
    });
    const user = await User.findOne({ email }).select("+password");

    // Act + Assert
    await expect(user.matchPassword("password123")).resolves.toBe(true);
    await expect(user.matchPassword("wrong")).resolves.toBe(false);
  });
});

// ==================== GOOGLE SIGN-IN ====================
describe("POST /api/auth/google", () => {
  it("creates a new user via Google and returns token", async () => {
    // Arrange
    givenGoogleUser({ sub: GOOGLE_SUB, email: uniqueEmail("google-new") });

    // Act
    const res = await makeGoogleLoginRequest({ idToken: "fake-google-token" });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.body.has_completed_onboarding).toBe(false);
  });

  it("returns has_completed_onboarding: true when Google user has a plan", async () => {
    // Arrange
    const email = uniqueEmail("google-with-plan");
    givenGoogleUser({ sub: GOOGLE_SUB, email });
    await makeGoogleLoginRequest({ idToken: "fake-google-token" });

    const user = await User.findOne({ email });
    await WorkoutPlan.create({
      userId: user._id,
      durationWeeks: 8,
      goal: "strength",
      weeks: [],
    });

    // Act
    const res = await makeGoogleLoginRequest({ idToken: "fake-google-token" });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.has_completed_onboarding).toBe(true);
  });

  it("links Google to existing email/password user without duplicating", async () => {
    // Arrange — the same address arrives first by password, then by Google
    const { email } = await registerTestUser({ name: "Google User" });
    givenGoogleUser({ sub: GOOGLE_SUB, email });

    // Act
    const res = await makeGoogleLoginRequest({ idToken: "fake-google-token" });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const users = await User.find({ email });
    expect(users).toHaveLength(1);
    expect(users[0].googleId).toBe(GOOGLE_SUB);
  });
});
