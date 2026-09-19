// Mock the Gemini service so the chat endpoint never hits the real API.
// This allows us to assert exactly what context the controller resolves and forwards.
jest.mock("../services/geminiService.js", () =>
  require("@test/mocks/geminiService.js").create(),
);

import ChatHistory from "../models/ChatHistory.js";
import User from "../models/User.js";
import WorkoutPlan from "../models/WorkoutPlan.js";
import { processChatMessage } from "../services/geminiService.js";
import { makeAuthenticatedChatRequest } from "@test/helpers/api.js";
import { registerTestUser } from "@test/helpers/auth.js";
import { silenceConsole } from "@test/helpers/console.js";
import { useTestDatabase } from "@test/helpers/db.js";
import { resetGeminiMocks } from "@test/mocks/geminiService.js";

useTestDatabase();

// The AI-failure test drives the controller's catch block, which logs before responding.
silenceConsole();

const registerCoachUser = () => registerTestUser({ name: "Coach User" });

beforeEach(() => {
  resetGeminiMocks();
  processChatMessage.mockResolvedValue("AI reply");
});

describe("POST /api/ai/chat", () => {
  it("rejects a request with no message payload", async () => {
    // Arrange
    const { token } = await registerCoachUser();

    // Act
    const res = await makeAuthenticatedChatRequest(token, {});

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("works with only a message (backward compatible) and persists the turn", async () => {
    // Arrange
    const { token } = await registerCoachUser();
    const payload = { message: "hello" };

    // Act
    const res = await makeAuthenticatedChatRequest(token, payload);

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.data.reply).toBe("AI reply");

    // Idiomatic Jest assertions instead of indexing the internal call array
    expect(processChatMessage).toHaveBeenCalledTimes(1);
    expect(processChatMessage).toHaveBeenCalledWith([], payload.message, "");

    // Verify the exchange is persisted to the durable log
    const storedHistory = await ChatHistory.findOne();
    expect(storedHistory).toBeDefined();
    expect(storedHistory.messages.map((m) => m.role)).toEqual([
      "user",
      "model",
    ]);
    expect(storedHistory.messages[1].content).toBe("AI reply");
  });

  it("injects client-sent plan_context and history into the Gemini call", async () => {
    // Arrange
    const { token } = await registerCoachUser();
    const payload = {
      message: "Why so much RPE on day 1?",
      plan_context: "Goal: both, Duration: 8 weeks. Day 1 Squats RPE 7",
      history: [
        { role: "user", content: "Hi" },
        { role: "model", content: "Hello! How can I help you?" },
      ],
    };

    // Act
    const res = await makeAuthenticatedChatRequest(token, payload);

    // Assert
    expect(res.status).toBe(200);
    expect(processChatMessage).toHaveBeenCalledWith(
      payload.history,
      payload.message,
      payload.plan_context,
    );
  });

  it("prefers client plan_context over the persisted plan", async () => {
    // Arrange
    const { token, email } = await registerCoachUser();
    const user = await User.findOne({ email });

    await WorkoutPlan.create({
      userId: user._id,
      durationWeeks: 8,
      goal: "strength",
      weeks: [],
    });

    const clientPlanContext = "CLIENT SUMMARY";

    // Act
    await makeAuthenticatedChatRequest(token, {
      message: "question",
      plan_context: clientPlanContext,
    });

    // Assert
    // expect.any(Array) isolates the test from caring about the exact history state here
    expect(processChatMessage).toHaveBeenCalledWith(
      expect.any(Array),
      "question",
      clientPlanContext,
    );
  });

  // Without a client-sent summary the controller has to go and find the active plan itself.
  // That fallback is the path the Android client actually takes on a cold start.
  it("falls back to the persisted plan when no plan_context is sent", async () => {
    // Arrange
    const { token, email } = await registerCoachUser();
    const user = await User.findOne({ email });
    await WorkoutPlan.create({
      userId: user._id,
      durationWeeks: 8,
      goal: "strength",
      weeks: [],
    });

    // Act
    await makeAuthenticatedChatRequest(token, { message: "what is my goal?" });

    // Assert
    expect(processChatMessage).toHaveBeenCalledWith(
      expect.any(Array),
      "what is my goal?",
      expect.stringContaining("strength"),
    );
  });

  // A long summary would otherwise eat the model's context window, so the controller clips it.
  it("truncates an oversized plan_context before forwarding it", async () => {
    // Arrange
    const { token } = await registerCoachUser();
    const oversized = "y".repeat(7000);

    // Act
    await makeAuthenticatedChatRequest(token, {
      message: "hi",
      plan_context: oversized,
    });

    // Assert
    expect(processChatMessage).toHaveBeenCalledWith(
      expect.any(Array),
      "hi",
      expect.stringMatching(/truncated/),
    );
  });

  it("tolerates a non-array history and filters invalid turns", async () => {
    // Arrange
    const { token } = await registerCoachUser();

    // Act - first call: non-array history is treated as empty
    const res1 = await makeAuthenticatedChatRequest(token, {
      message: "a",
      history: "not-an-array",
    });

    // Assert
    expect(res1.status).toBe(200);
    expect(processChatMessage).toHaveBeenNthCalledWith(
      1, // Specific assertion for the first call
      [],
      "a",
      expect.any(String),
    );

    // Act - second call: invalid roles / empty content are filtered out
    const res2 = await makeAuthenticatedChatRequest(token, {
      message: "b",
      history: [
        { role: "system", content: "nope" },
        { role: "user", content: "hi" },
        { role: "model", content: "ok" },
        { role: "user", content: "" }, // empty content
      ],
    });

    // Assert
    expect(res2.status).toBe(200);
    expect(processChatMessage).toHaveBeenNthCalledWith(
      2, // Specific assertion for the second call
      [
        { role: "user", content: "hi" },
        { role: "model", content: "ok" },
      ],
      "b",
      expect.any(String),
    );
  });

  // Gemini's contents array must start with a user turn and must not end on one, so the
  // controller trims the sanitised history from both ends. Neither trim fired in the filtering
  // test above: that payload already happened to satisfy both constraints.
  it("trims a leading model turn and a trailing user turn from the history", async () => {
    // Arrange
    const { token } = await registerCoachUser();

    // Act
    await makeAuthenticatedChatRequest(token, {
      message: "c",
      history: [
        { role: "model", content: "x" }, // leading model turn - dropped
        { role: "user", content: "a" },
        { role: "model", content: "b" },
        { role: "user", content: "c" }, // trailing user turn - dropped
      ],
    });

    // Assert
    expect(processChatMessage).toHaveBeenCalledWith(
      [
        { role: "user", content: "a" },
        { role: "model", content: "b" },
      ],
      "c",
      expect.any(String),
    );
  });

  it("returns 500 when the coach service fails", async () => {
    // Arrange
    const { token } = await registerCoachUser();
    processChatMessage.mockRejectedValue(new Error("Gemini exploded"));

    // Act
    const res = await makeAuthenticatedChatRequest(token, { message: "hello" });

    // Assert
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
