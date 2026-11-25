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
  makeRawLoginRequest,
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

// ==================== INPUT VALIDATION ====================
describe("auth request validation", () => {
  it("rejects an operator object as the login email instead of querying with it", async () => {
    // Arrange
    await registerTestUser();

    // Act
    const res = await makeLoginRequest({
      email: { $ne: null },
      password: "password123",
    });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.token).toBeUndefined();
  });

  it("rejects an operator object as the register email", async () => {
    // Act
    const res = await makeRegisterRequest({
      email: { $regex: ".*" },
      password: "password123",
    });

    // Assert
    expect(res.status).toBe(400);
  });

  it("answers 400, not 500, for a non-string password", async () => {
    // Act
    const res = await makeLoginRequest({
      email: uniqueEmail("object-password"),
      password: { $gt: "" },
    });

    // Assert
    expect(res.status).toBe(400);
  });

  it("rejects a 129-character password on register", async () => {
    // Arrange
    const email = uniqueEmail("long-password");

    // Act
    const res = await makeRegisterRequest({
      email,
      password: "a".repeat(129),
    });

    // Assert
    expect(res.status).toBe(400);
    expect(await User.countDocuments({ email })).toBe(0);
  });

  it("answers malformed JSON with a JSON 400", async () => {
    // Act
    const res = await makeRawLoginRequest("{bad");

    // Assert
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      message: "Malformed JSON body",
    });
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

  it("refuses an unverified Google email", async () => {
    // Arrange
    const email = uniqueEmail("google-unverified");
    givenGoogleUser({ sub: GOOGLE_SUB, email, emailVerified: false });

    // Act
    const res = await makeGoogleLoginRequest({ idToken: "fake-google-token" });

    // Assert
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Your Google account email is not verified.");
    expect(await User.countDocuments({ email })).toBe(0);
  });

  it("answers 409 when the email belongs to a different Google account", async () => {
    // Arrange
    const email = uniqueEmail("google-conflict");
    await User.create({ name: "Owner", email, googleId: "google-owner" });
    givenGoogleUser({ sub: "google-intruder", email });

    // Act
    const res = await makeGoogleLoginRequest({ idToken: "fake-google-token" });

    // Assert
    expect(res.status).toBe(409);
    expect(res.body.message).toBe(
      "This email is linked to a different Google account.",
    );
    const owner = await User.findOne({ email });
    expect(owner.googleId).toBe("google-owner");
  });

  it("logs in by googleId even when the Google email has changed", async () => {
    // Arrange
    const sub = `google-${randomUUID()}`;
    const user = await User.create({
      name: "Mover",
      email: uniqueEmail("google-old"),
      googleId: sub,
    });
    givenGoogleUser({ sub, email: uniqueEmail("google-new-address") });

    // Act
    const res = await makeGoogleLoginRequest({ idToken: "fake-google-token" });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(String(user._id));
  });

  it("matches the existing account case-insensitively", async () => {
    // Arrange
    const { email } = await registerTestUser({ name: "Mixed Case" });
    givenGoogleUser({ sub: GOOGLE_SUB, email: email.toUpperCase() });

    // Act
    const res = await makeGoogleLoginRequest({ idToken: "fake-google-token" });

    // Assert
    expect(res.status).toBe(200);
    expect(await User.countDocuments({ email })).toBe(1);
  });
});
