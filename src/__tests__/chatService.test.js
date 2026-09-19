jest.mock("../services/geminiService.js", () =>
  require("@test/mocks/geminiService.js").create(),
);

import mongoose from "mongoose";
import ChatMessage from "../models/ChatMessage.js";
import ChatSession from "../models/ChatSession.js";
import WorkoutPlan from "../models/WorkoutPlan.js";
import { getCoachHistory, sendCoachMessage } from "../services/chatService.js";
import {
  generateCoachReply,
  resetGeminiMocks,
} from "@test/mocks/geminiService.js";
import { useTestDatabase } from "@test/helpers/db.js";

useTestDatabase();

beforeEach(() => {
  resetGeminiMocks();
  generateCoachReply.mockResolvedValue("coach reply");
});

const anUserId = () => new mongoose.Types.ObjectId();

const seedPlan = (userId) =>
  WorkoutPlan.create({
    userId,
    durationWeeks: 8,
    goal: "both",
    weeks: [
      {
        weekNumber: 1,
        days: [
          {
            dayName: "Lower Body",
            workoutType: "strength",
            exercises: [{ name: "Back Squat", sets: "4", reps: "6", rpe: "8" }],
          },
        ],
      },
    ],
  });

describe("sendCoachMessage", () => {
  it("assembles the payload as routine, then history, then the new message", async () => {
    // Arrange
    const userId = anUserId();
    await seedPlan(userId);
    await sendCoachMessage({ userId, message: "hola" });

    // Act
    await sendCoachMessage({ userId, message: "¿y el squat?" });

    // Assert
    expect(generateCoachReply).toHaveBeenLastCalledWith({
      routineContext: expect.stringContaining("Back Squat 4x6 @RPE 8"),
      history: [
        { role: "user", content: "hola" },
        { role: "model", content: "coach reply" },
      ],
      message: "¿y el squat?",
    });
  });

  it("starts with an empty window and no routine for a new athlete", async () => {
    // Arrange / Act
    await sendCoachMessage({ userId: anUserId(), message: "hola" });

    // Assert
    expect(generateCoachReply).toHaveBeenCalledWith({
      routineContext: "",
      history: [],
      message: "hola",
    });
  });

  it("persists both turns in order and returns the reply", async () => {
    // Arrange
    const userId = anUserId();

    // Act
    const result = await sendCoachMessage({ userId, message: "hola" });

    // Assert
    expect(result.reply).toBe("coach reply");
    const stored = await ChatMessage.find({ userId })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    expect(stored.map((message) => message.role)).toEqual(["user", "model"]);
    expect(stored[1].content).toBe("coach reply");
    expect(stored[1].createdAt).toEqual(result.timestamp);
  });

  it("keeps every message in one conversation and tracks it on the session", async () => {
    // Arrange
    const userId = anUserId();

    // Act
    await sendCoachMessage({ userId, message: "one" });
    await sendCoachMessage({ userId, message: "two" });

    // Assert
    expect(await ChatSession.countDocuments({ userId })).toBe(1);
    const session = await ChatSession.findOne({ userId }).lean();
    expect(session.messageCount).toBe(4);
  });

  it("persists nothing when the model fails, so the turn is not billed", async () => {
    // Arrange
    const userId = anUserId();
    generateCoachReply.mockRejectedValueOnce(new Error("Gemini is down"));

    // Act / Assert
    await expect(sendCoachMessage({ userId, message: "hola" })).rejects.toThrow(
      "Gemini is down",
    );
    expect(await ChatMessage.countDocuments({ userId })).toBe(0);
  });

  it("bounds the window it sends, however long the conversation gets", async () => {
    // Arrange: 12 exchanges against a 6-turn window
    const previous = process.env.CHAT_WINDOW_MAX_TURNS;
    process.env.CHAT_WINDOW_MAX_TURNS = "6";
    const userId = anUserId();
    for (let index = 0; index < 12; index++) {
      await sendCoachMessage({ userId, message: `message ${index}` });
    }

    // Act
    await sendCoachMessage({ userId, message: "latest" });

    // Assert: the six most recent turns, and nothing older
    expect(generateCoachReply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        history: [
          { role: "user", content: "message 9" },
          { role: "model", content: "coach reply" },
          { role: "user", content: "message 10" },
          { role: "model", content: "coach reply" },
          { role: "user", content: "message 11" },
          { role: "model", content: "coach reply" },
        ],
      }),
    );

    process.env.CHAT_WINDOW_MAX_TURNS = previous;
  });

  it("does not leak another athlete's conversation", async () => {
    // Arrange
    const mine = anUserId();
    await sendCoachMessage({ userId: anUserId(), message: "their secret" });

    // Act
    await sendCoachMessage({ userId: mine, message: "hola" });

    // Assert
    expect(generateCoachReply).toHaveBeenLastCalledWith(
      expect.objectContaining({ history: [] }),
    );
  });
});

describe("getCoachHistory", () => {
  it("returns an empty page for an athlete who has never chatted, without creating a session", async () => {
    // Arrange
    const userId = anUserId();

    // Act
    const page = await getCoachHistory({ userId });

    // Assert
    expect(page).toEqual({ messages: [], hasMore: false });
    expect(await ChatSession.countDocuments({ userId })).toBe(0);
  });

  it("returns the transcript oldest first", async () => {
    // Arrange
    const userId = anUserId();
    await sendCoachMessage({ userId, message: "one" });
    await sendCoachMessage({ userId, message: "two" });

    // Act
    const page = await getCoachHistory({ userId });

    // Assert
    expect(page.messages.map((message) => message.content)).toEqual([
      "one",
      "coach reply",
      "two",
      "coach reply",
    ]);
    expect(page.hasMore).toBe(false);
  });

  it("reports another page and paginates backwards from it", async () => {
    // Arrange: 3 exchanges = 6 turns
    const userId = anUserId();
    for (const message of ["one", "two", "three"]) {
      await sendCoachMessage({ userId, message });
    }

    // Act
    const newest = await getCoachHistory({ userId, limit: 2 });
    const older = await getCoachHistory({
      userId,
      limit: 2,
      before: newest.messages[0].createdAt,
    });

    // Assert
    expect(newest.hasMore).toBe(true);
    expect(newest.messages.map((message) => message.content)).toEqual([
      "three",
      "coach reply",
    ]);
    expect(older.messages.map((message) => message.content)).toEqual([
      "two",
      "coach reply",
    ]);
  });

  it("caps an oversized page request at the configured size", async () => {
    // Arrange
    const previous = process.env.CHAT_HISTORY_PAGE_SIZE;
    process.env.CHAT_HISTORY_PAGE_SIZE = "2";
    const userId = anUserId();
    for (const message of ["one", "two", "three"]) {
      await sendCoachMessage({ userId, message });
    }

    // Act
    const page = await getCoachHistory({ userId, limit: 500 });

    // Assert
    expect(page.messages).toHaveLength(2);

    process.env.CHAT_HISTORY_PAGE_SIZE = previous;
  });
});
