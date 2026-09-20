import mongoose from "mongoose";
import ChatMessage from "../models/ChatMessage.js";
import ChatSession from "../models/ChatSession.js";
import {
  appendMessages,
  countUserMessagesSince,
  findRecentMessages,
  getOrCreateSession,
  touchSession,
} from "../repositories/chatRepository.js";
import { useTestDatabase } from "@test/helpers/db.js";

useTestDatabase();

const anUserId = () => new mongoose.Types.ObjectId();
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000);

/** Seeds an alternating conversation, oldest first, one minute apart. */
const seedConversation = async (sessionId, userId, contents) =>
  appendMessages({
    sessionId,
    userId,
    turns: contents.map((content, index) => ({
      role: index % 2 === 0 ? "user" : "model",
      content,
      createdAt: minutesAgo(contents.length - index),
    })),
  });

describe("getOrCreateSession", () => {
  it("creates the session on first use and reuses it afterwards", async () => {
    // Arrange
    const userId = anUserId();

    // Act
    const first = await getOrCreateSession(userId);
    const second = await getOrCreateSession(userId);

    // Assert
    expect(String(first._id)).toBe(String(second._id));
    expect(await ChatSession.countDocuments({ userId })).toBe(1);
  });

  it("reads the winner's session when the unique index rejects a losing upsert", async () => {
    // Arrange: the race that the unique index on userId is there to arbitrate. Driving it
    // through a real collision is timing-dependent, so the duplicate-key answer is injected.
    const userId = anUserId();
    const winner = await getOrCreateSession(userId);
    const upsert = jest
      .spyOn(ChatSession, "findOneAndUpdate")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      });

    // Act
    const session = await getOrCreateSession(userId);

    // Assert
    expect(String(session._id)).toBe(String(winner._id));
    upsert.mockRestore();
  });

  it("propagates a write failure that is not the upsert race", async () => {
    // Arrange
    const upsert = jest
      .spyOn(ChatSession, "findOneAndUpdate")
      .mockImplementationOnce(() => {
        throw new Error("connection lost");
      });

    // Act / Assert
    await expect(getOrCreateSession(anUserId())).rejects.toThrow(
      "connection lost",
    );
    upsert.mockRestore();
  });

  it("returns a plain object, not a Mongoose document", async () => {
    // Arrange / Act
    const session = await getOrCreateSession(anUserId());

    // Assert: nothing above the repository can accidentally mutate and .save() a session
    expect(session.save).toBeUndefined();
    expect(session.messageCount).toBe(0);
  });

  it("gives concurrent first messages the same session", async () => {
    // Arrange: the unique index on userId is what makes the upsert race safe
    const userId = anUserId();

    // Act
    const sessions = await Promise.all([
      getOrCreateSession(userId),
      getOrCreateSession(userId),
      getOrCreateSession(userId),
    ]);

    // Assert
    const ids = new Set(sessions.map((session) => String(session._id)));
    expect(ids.size).toBe(1);
    expect(await ChatSession.countDocuments({ userId })).toBe(1);
  });
});

describe("appendMessages", () => {
  it("persists a whole exchange with its roles and owner", async () => {
    // Arrange
    const userId = anUserId();
    const session = await getOrCreateSession(userId);
    const now = new Date();

    // Act
    const created = await appendMessages({
      sessionId: session._id,
      userId,
      turns: [
        { role: "user", content: "How heavy today?", createdAt: now },
        { role: "model", content: "RPE 8.", createdAt: now },
      ],
    });

    // Assert
    expect(created).toHaveLength(2);
    // Sorted by insertion order: both turns of one exchange can share a timestamp, which is
    // exactly why `_id` is part of the index key.
    const stored = await ChatMessage.find({ sessionId: session._id })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    expect(stored.map((message) => message.role)).toEqual(["user", "model"]);
    expect(
      stored.every((message) => String(message.userId) === String(userId)),
    ).toBe(true);
  });

  it("rejects an empty reply instead of storing a turn the next prompt would carry", async () => {
    // Arrange
    const userId = anUserId();
    const session = await getOrCreateSession(userId);

    // Act / Assert
    await expect(
      appendMessages({
        sessionId: session._id,
        userId,
        turns: [{ role: "model", content: "", createdAt: new Date() }],
      }),
    ).rejects.toThrow();
  });
});

describe("findRecentMessages", () => {
  it("returns the newest turns first, capped at the limit", async () => {
    // Arrange
    const userId = anUserId();
    const session = await getOrCreateSession(userId);
    await seedConversation(session._id, userId, ["q1", "a1", "q2", "a2"]);

    // Act
    const recent = await findRecentMessages({
      sessionId: session._id,
      limit: 2,
    });

    // Assert
    expect(recent.map((message) => message.content)).toEqual(["a2", "q2"]);
  });

  it("projects only the fields a prompt needs, as plain objects", async () => {
    // Arrange
    const userId = anUserId();
    const session = await getOrCreateSession(userId);
    await seedConversation(session._id, userId, ["only"]);

    // Act
    const [message] = await findRecentMessages({
      sessionId: session._id,
      limit: 10,
    });

    // Assert
    expect(message.save).toBeUndefined();
    expect(Object.keys(message).sort()).toEqual([
      "_id",
      "content",
      "createdAt",
      "role",
    ]);
  });

  it("paginates backwards with `before`", async () => {
    // Arrange
    const userId = anUserId();
    const session = await getOrCreateSession(userId);
    await seedConversation(session._id, userId, ["q1", "a1", "q2", "a2"]);
    const [newest] = await findRecentMessages({
      sessionId: session._id,
      limit: 1,
    });

    // Act
    const older = await findRecentMessages({
      sessionId: session._id,
      limit: 2,
      before: newest.createdAt,
    });

    // Assert
    expect(older.map((message) => message.content)).toEqual(["q2", "a1"]);
  });

  it("does not read another session's messages", async () => {
    // Arrange
    const mine = await getOrCreateSession(anUserId());
    const theirsUserId = anUserId();
    const theirs = await getOrCreateSession(theirsUserId);
    await seedConversation(theirs._id, theirsUserId, ["their secret"]);

    // Act
    const recent = await findRecentMessages({ sessionId: mine._id, limit: 10 });

    // Assert
    expect(recent).toEqual([]);
  });
});

describe("touchSession", () => {
  it("advances the cursor and increments the counter", async () => {
    // Arrange
    const session = await getOrCreateSession(anUserId());
    const lastMessageAt = new Date();

    // Act
    await touchSession({ sessionId: session._id, lastMessageAt, added: 2 });

    // Assert
    const updated = await ChatSession.findById(session._id).lean();
    expect(updated.messageCount).toBe(2);
    expect(updated.lastMessageAt.getTime()).toBe(lastMessageAt.getTime());
  });
});

describe("countUserMessagesSince", () => {
  it("counts user turns only, and only inside the window", async () => {
    // Arrange
    const userId = anUserId();
    const session = await getOrCreateSession(userId);
    await appendMessages({
      sessionId: session._id,
      userId,
      turns: [
        { role: "user", content: "yesterday", createdAt: minutesAgo(48 * 60) },
        { role: "user", content: "recent", createdAt: minutesAgo(5) },
        {
          role: "model",
          content: "a reply is not spent quota",
          createdAt: minutesAgo(4),
        },
      ],
    });

    // Act
    const used = await countUserMessagesSince(userId, minutesAgo(60));

    // Assert
    expect(used).toBe(1);
  });

  it("does not count another athlete's messages", async () => {
    // Arrange
    const mineUserId = anUserId();
    const theirsUserId = anUserId();
    const theirs = await getOrCreateSession(theirsUserId);
    await seedConversation(theirs._id, theirsUserId, ["their message"]);

    // Act
    const used = await countUserMessagesSince(mineUserId, minutesAgo(60));

    // Assert
    expect(used).toBe(0);
  });
});
