import {
  buildWindow,
  normalizeTurns,
  trimForGemini,
} from "../services/chatWindow.js";

// No database and no mocks: every rule in chatWindow is a decision about a list of turns.

const user = (content) => ({ role: "user", content });
const model = (content) => ({ role: "model", content });

/** A valid alternating conversation of `pairs` exchanges, oldest first. */
const conversation = (pairs) =>
  Array.from({ length: pairs }, (_, i) => [
    user(`q${i}`),
    model(`a${i}`),
  ]).flat();

describe("normalizeTurns", () => {
  it("drops turns whose role is not a Gemini role", () => {
    // Arrange
    const turns = [user("keep"), { role: "system", content: "drop" }];

    // Act
    const result = normalizeTurns(turns);

    // Assert
    expect(result).toEqual([{ role: "user", content: "keep" }]);
  });

  it("drops blank and non-string content", () => {
    // Arrange
    const turns = [user("keep"), user("   "), { role: "model", content: 42 }];

    // Act
    const result = normalizeTurns(turns);

    // Assert
    expect(result).toEqual([{ role: "user", content: "keep" }]);
  });

  it("strips every field the model does not consume", () => {
    // Arrange: what the repository returns carries _id and createdAt
    const stored = [
      { role: "user", content: "hi", _id: "abc", createdAt: new Date() },
    ];

    // Act
    const result = normalizeTurns(stored);

    // Assert
    expect(result).toEqual([{ role: "user", content: "hi" }]);
  });

  it("returns an empty array for anything that is not an array", () => {
    // Arrange / Act / Assert
    expect(normalizeTurns(undefined)).toEqual([]);
    expect(normalizeTurns("not-an-array")).toEqual([]);
    expect(normalizeTurns(null)).toEqual([]);
  });
});

describe("trimForGemini", () => {
  it("drops leading model turns, because history must open on a user turn", () => {
    // Arrange
    const turns = [model("orphan"), user("q"), model("a")];

    // Act
    const result = trimForGemini(turns);

    // Assert
    expect(result).toEqual([user("q"), model("a")]);
  });

  it("drops a trailing user turn, because sendMessage appends the current one", () => {
    // Arrange
    const turns = [user("q"), model("a"), user("unanswered")];

    // Act
    const result = trimForGemini(turns);

    // Assert
    expect(result).toEqual([user("q"), model("a")]);
  });

  it("empties a window that cannot be made valid", () => {
    // Arrange
    const turns = [model("only"), model("model"), model("turns")];

    // Act / Assert
    expect(trimForGemini(turns)).toEqual([]);
  });
});

describe("buildWindow", () => {
  it("keeps only the most recent turns once the cap is reached", () => {
    // Arrange: 10 exchanges, cap of 4 turns
    const turns = conversation(10);

    // Act
    const result = buildWindow(turns, { maxTurns: 4, maxChars: 10000 });

    // Assert
    expect(result).toEqual([user("q8"), model("a8"), user("q9"), model("a9")]);
  });

  it("drops the oldest turns first when the character budget is exceeded", () => {
    // Arrange: each turn costs 10 characters, budget fits two of them
    const turns = [
      user("a".repeat(10)),
      model("b".repeat(10)),
      user("c".repeat(10)),
      model("d".repeat(10)),
    ];

    // Act
    const result = buildWindow(turns, { maxTurns: 20, maxChars: 20 });

    // Assert
    expect(result).toEqual([turns[2], turns[3]]);
  });

  it("applies the validity trim AFTER the budget cut, not before", () => {
    // Arrange: the budget fits the last three turns, which start on a 'model' turn. Trimming
    // before the cut would leave that orphan at the head and Gemini would reject the request.
    const turns = [
      user("a".repeat(30)),
      model("b".repeat(10)),
      user("c".repeat(10)),
      model("d".repeat(10)),
    ];

    // Act
    const result = buildWindow(turns, { maxTurns: 20, maxChars: 30 });

    // Assert
    expect(result).toEqual([turns[2], turns[3]]);
  });

  it("drops a single turn larger than the whole budget rather than truncating it", () => {
    // Arrange
    const turns = [user("x".repeat(500)), model("y".repeat(500))];

    // Act
    const result = buildWindow(turns, { maxTurns: 20, maxChars: 100 });

    // Assert
    expect(result).toEqual([]);
  });

  it("reads its defaults from the environment", () => {
    // Arrange
    const previous = process.env.CHAT_WINDOW_MAX_TURNS;
    process.env.CHAT_WINDOW_MAX_TURNS = "2";

    // Act
    const result = buildWindow(conversation(5));

    // Assert
    expect(result).toEqual([user("q4"), model("a4")]);

    process.env.CHAT_WINDOW_MAX_TURNS = previous;
  });

  it("returns an empty window for an empty conversation", () => {
    // Arrange / Act / Assert
    expect(buildWindow([])).toEqual([]);
    expect(buildWindow(undefined)).toEqual([]);
  });
});
