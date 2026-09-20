// Capture what is handed to Gemini without hitting the real API.
// Jest only allows the mock factory to reference variables prefixed with "mock".
const mockGenerateContent = jest.fn().mockResolvedValue({
  response: {
    text: () => JSON.stringify({ durationWeeks: 8, goal: "both", weeks: [] }),
  },
});
const mockSendMessage = jest.fn().mockResolvedValue({
  response: { text: () => "coach reply" },
});
const mockStartChat = jest.fn(() => ({ sendMessage: mockSendMessage }));
const mockGetGenerativeModel = jest.fn(() => ({
  generateContent: mockGenerateContent,
  startChat: mockStartChat,
}));

jest.mock("@google/generative-ai", () => ({
  // SchemaType is read at module load when building workoutPlanSchema; a proxy that
  // returns the property name for any key is enough to let the module initialize.
  SchemaType: new Proxy({}, { get: (_target, prop) => String(prop) }),
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    // Wrapped in an arrow so the mock is referenced lazily (at call time), avoiding a TDZ
    // error: babel hoists the service import above these const declarations.
    getGenerativeModel: (...args) => mockGetGenerativeModel(...args),
  })),
}));

import {
  generateCoachReply,
  generateWorkoutPlan,
  importAndCompleteWorkoutPlan,
} from "../services/geminiService.js";
import { silenceConsole } from "@test/helpers/console.js";

// The retry tests deliberately drive the warn/error logging in callWithRetry.
const consoleSpies = silenceConsole();

afterEach(() => {
  mockGenerateContent.mockClear();
  mockSendMessage.mockClear();
  mockStartChat.mockClear();
  mockGetGenerativeModel.mockClear();
});

// The instruction text is always the last part of the contents array, after any uploads.
// This keeps the assertions semantic (toHaveBeenCalledWith) instead of indexing mock.calls.
const promptContaining = (fragment) =>
  expect.arrayContaining([
    expect.objectContaining({ text: expect.stringContaining(fragment) }),
  ]);

// The response schema is a deeply nested object and the assertions below are about the ABSENCE
// of a field several levels down, which no asymmetric matcher can express. This single named
// accessor is the one place the call record is read directly; everything else asserts on the
// call itself.
const lastModelConfig = () => mockGetGenerativeModel.mock.lastCall[0];

const daySchemaOf = (modelConfig) =>
  modelConfig.generationConfig.responseSchema.properties.weeks.items.properties
    .days.items;

describe("generateWorkoutPlan — prompt content", () => {
  it("includes injuries and the cycle-aware block for a female with last_period_date", async () => {
    // Act
    await generateWorkoutPlan({
      planDuration: 8,
      goal: "both",
      fitnessLevel: "intermediate",
      daysAvailable: 4,
      weight: 60,
      sex: "female",
      injuries: ["left knee", "lower back"],
      last_period_date: "2026-07-01",
    });

    // Assert
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.stringContaining("left knee"),
    );
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.stringContaining("lower back"),
    );
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.stringContaining("2026-07-01"),
    );
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.stringMatching(/MENSTRUAL CYCLE AWARENESS/i),
    );
  });

  it('omits the cycle block for male users and shows "None reported" when no injuries', async () => {
    // Act
    await generateWorkoutPlan({
      planDuration: 8,
      goal: "strength",
      fitnessLevel: "beginner",
      daysAvailable: 3,
      weight: 80,
      sex: "male",
      injuries: [],
    });

    // Assert
    expect(mockGenerateContent).not.toHaveBeenCalledWith(
      expect.stringMatching(/MENSTRUAL CYCLE AWARENESS/i),
    );
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.stringContaining("None reported"),
    );
  });

  it("does not emit the cycle block for a female missing last_period_date", async () => {
    // Act
    await generateWorkoutPlan({
      planDuration: 4,
      goal: "endurance",
      fitnessLevel: "advanced",
      daysAvailable: 5,
      weight: 55,
      sex: "female",
      injuries: ["shoulder"],
    });

    // Assert
    expect(mockGenerateContent).not.toHaveBeenCalledWith(
      expect.stringMatching(/MENSTRUAL CYCLE AWARENESS/i),
    );
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.stringContaining("shoulder"),
    );
  });
});

describe("importAndCompleteWorkoutPlan — contents and prompt", () => {
  const profile = {
    planDuration: 8,
    goal: "both",
    fitnessLevel: "intermediate",
    daysAvailable: 5,
    weight: 78,
    sex: "male",
    injuries: ["left knee"],
  };

  it("sends the attachments as inlineData parts before the instruction text", async () => {
    // Act
    await importAndCompleteWorkoutPlan(profile, {
      providedDomain: "strength",
      planDuration: 8,
      sourceText: "",
      attachments: [
        { mimeType: "application/pdf", data: "JVBERi0xLjQK" },
        { mimeType: "image/jpeg", data: "/9j/4AAQSkZJRg==" },
      ],
    });

    // Assert - the exact array pins the ordering: uploads first, instruction text last.
    expect(mockGenerateContent).toHaveBeenCalledWith([
      { inlineData: { mimeType: "application/pdf", data: "JVBERi0xLjQK" } },
      { inlineData: { mimeType: "image/jpeg", data: "/9j/4AAQSkZJRg==" } },
      { text: expect.stringContaining("2 document(s)/image(s)") },
    ]);
  });

  it("asks the model to reproduce the strength half and author only the cardio half", async () => {
    // Act
    await importAndCompleteWorkoutPlan(profile, {
      providedDomain: "strength",
      planDuration: 8,
      sourceText: "Day A: Squat 5x5 @RPE8",
      attachments: [],
    });

    // Assert
    for (const fragment of [
      "Squat 5x5 @RPE8",
      "FIDELITY",
      // The imported half keeps the domain the athlete supplied...
      "workoutType 'strength'",
      "source 'imported'",
      // ...and the model is told to write the other one, and only that one.
      "You author ONLY the cardio half",
      "Never write a 'strength' day of your own",
      "exactly 8 weeks",
      "must not exceed 5",
      "left knee",
    ]) {
      expect(mockGenerateContent).toHaveBeenCalledWith(
        promptContaining(fragment),
      );
    }

    // Without attachments there is nothing to announce.
    expect(mockGenerateContent).not.toHaveBeenCalledWith(
      promptContaining("document(s)/image(s)"),
    );
  });

  it("flips the roles when the athlete supplies their running block instead", async () => {
    // Act
    await importAndCompleteWorkoutPlan(
      { ...profile, sex: "female", last_period_date: "2026-07-01" },
      {
        providedDomain: "cardio",
        planDuration: 12,
        sourceText: "Tue: 8km easy",
        attachments: [],
      },
    );

    // Assert
    for (const fragment of [
      "workoutType 'cardio'",
      "You author ONLY the strength half",
      "Never write a 'cardio' day of your own",
      // The cycle-aware block is shared with the generation path.
      "MENSTRUAL CYCLE AWARENESS",
      "2026-07-01",
    ]) {
      expect(mockGenerateContent).toHaveBeenCalledWith(
        promptContaining(fragment),
      );
    }
  });

  it("requests the source-carrying response schema", async () => {
    // Act
    await importAndCompleteWorkoutPlan(profile, {
      providedDomain: "strength",
      planDuration: 4,
      sourceText: "anything",
      attachments: [],
    });

    // Assert
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        generationConfig: expect.objectContaining({
          responseSchema: expect.any(Object),
        }),
      }),
    );
    const daySchema = daySchemaOf(lastModelConfig());
    expect(daySchema.properties.source).toBeDefined();
    expect(daySchema.required).toContain("source");
  });

  it("leaves the generation schema untouched (no source field)", async () => {
    // Act
    await generateWorkoutPlan(profile);

    // Assert
    const daySchema = daySchemaOf(lastModelConfig());
    expect(daySchema.properties.source).toBeUndefined();
    expect(daySchema.required).not.toContain("source");
  });
});

describe("generateCoachReply — payload assembly", () => {
  it("sends the hydrated routine, then the history, then the new message", async () => {
    // Arrange
    const routineContext =
      "PLAN: both — week 2 of 8 (base).\nNEXT SESSION: Lower Body — Back Squat 4x6 @RPE 8";

    // Act
    const reply = await generateCoachReply({
      routineContext,
      history: [
        { role: "user", content: "Hola" },
        { role: "model", content: "¡Hola! ¿En qué te ayudo?" },
      ],
      message: "¿qué toca hoy?",
    });

    // Assert
    expect(reply).toBe("coach reply");
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        systemInstruction: expect.stringContaining("current training plan"),
      }),
    );
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        systemInstruction: expect.stringContaining("Back Squat 4x6 @RPE 8"),
      }),
    );
    expect(mockStartChat).toHaveBeenCalledWith(
      expect.objectContaining({
        history: [
          { role: "user", parts: [{ text: "Hola" }] },
          { role: "model", parts: [{ text: "¡Hola! ¿En qué te ayudo?" }] },
        ],
      }),
    );
    expect(mockSendMessage).toHaveBeenCalledWith("¿qué toca hoy?");
  });

  it("omits the routine block entirely when the athlete has no plan", async () => {
    // Act
    await generateCoachReply({ message: "hola" });

    // Assert
    expect(mockGetGenerativeModel).not.toHaveBeenCalledWith(
      expect.objectContaining({
        systemInstruction: expect.stringContaining("current training plan"),
      }),
    );
    expect(mockStartChat).toHaveBeenCalledWith(
      expect.objectContaining({ history: [] }),
    );
  });

  it("tells the coach to answer in the athlete's language", async () => {
    // The instructions are written in English, so without this rule the model answers in English
    // to a Spanish-speaking athlete using a Spanish UI — which is what it was doing.
    // Arrange / Act
    await generateCoachReply({ message: "¿Cuánto peso?" });

    // Assert
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        systemInstruction: expect.stringContaining(
          "same language the athlete writes in",
        ),
      }),
    );
  });

  it("confines the coach to training, and forbids answering anyway", async () => {
    // Without a scope the coach did arithmetic homework, and every one of those is a paid call.
    // The "do not answer it anyway" half matters: a model told only to stay on topic will
    // typically decline and then answer regardless.
    // Arrange / Act
    await generateCoachReply({ message: "what is 2+2?" });

    // Assert
    const { systemInstruction } = lastModelConfig();
    expect(systemInstruction).toContain("you cover training only");
    expect(systemInstruction).toContain("out of scope");
    expect(systemInstruction).toContain("do not answer it anyway");
  });

  it("keeps the persona when the routine block is attached", async () => {
    // Arrange / Act
    await generateCoachReply({
      message: "¿qué toca?",
      routineContext: "PLAN: both — week 2 of 8 (base).",
    });

    // Assert: hydration must extend the persona, never replace it
    const { systemInstruction } = lastModelConfig();
    expect(systemInstruction).toContain("same language the athlete writes in");
    expect(systemInstruction).toContain("current training plan");
    expect(systemInstruction).toContain("week 2 of 8");
  });

  it("asks for prose, never for JSON", async () => {
    // Arrange / Act
    await generateCoachReply({ message: "hola" });

    // Assert: the plan flows pin a responseSchema; a chat reply that arrived as JSON would be
    // rendered to the athlete verbatim, braces and all.
    const { generationConfig } = lastModelConfig();
    expect(generationConfig).toEqual(
      expect.objectContaining({ maxOutputTokens: expect.any(Number) }),
    );
    expect(generationConfig.responseMimeType).toBeUndefined();
    expect(generationConfig.responseSchema).toBeUndefined();
  });

  it("retries a busy model and rebuilds the chat session per attempt", async () => {
    // Arrange: a reused session would replay the user turn on the second send
    mockSendMessage.mockRejectedValueOnce({ status: 503 });

    // Act
    const reply = await generateCoachReply({ message: "hola" });

    // Assert
    expect(reply).toBe("coach reply");
    expect(mockStartChat).toHaveBeenCalledTimes(2);
    expect(consoleSpies.warn).toHaveBeenCalled();
  });

  it("refuses an empty reply instead of storing a silent turn", async () => {
    // Arrange: the 2.5 models can answer with no text when the output budget is exhausted
    mockSendMessage.mockResolvedValueOnce({ response: { text: () => "  " } });

    // Act / Assert
    await expect(generateCoachReply({ message: "hola" })).rejects.toThrow(
      "empty coach reply",
    );
  });
});

// Gemini answers 503 when the model is overloaded and 429 on rate limits; both are transient,
// so the service backs off and retries. Anything else is a real fault and must fail fast rather
// than burn three attempts and ~14 seconds of the request's budget.
describe("callWithRetry", () => {
  const profile = {
    age: 30,
    sex: "male",
    goal: "strength",
    fitnessLevel: "intermediate",
    daysAvailable: 4,
    planDuration: 8,
  };

  const transient = (status) => Object.assign(new Error("busy"), { status });

  it("does not retry a non-transient error", async () => {
    // Arrange
    mockGenerateContent.mockRejectedValueOnce(transient(500));

    // Act + Assert
    await expect(generateWorkoutPlan(profile)).rejects.toThrow(
      /Failed to connect to Gemini AI after multiple attempts/,
    );
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(consoleSpies.warn).not.toHaveBeenCalled();
  });

  it("retries a 503 and succeeds on the second attempt", async () => {
    // Arrange
    jest.useFakeTimers();
    mockGenerateContent.mockRejectedValueOnce(transient(503));

    // Act — the backoff is a real 2s sleep, so drive it with fake timers
    const pending = generateWorkoutPlan(profile, 2);
    await jest.advanceTimersByTimeAsync(2000);
    const plan = await pending;

    // Assert
    expect(JSON.parse(plan).goal).toBe("both");
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    expect(consoleSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining("Retrying attempt 1"),
    );

    jest.useRealTimers();
  });

  it("gives up once the retry budget is spent, even for a 429", async () => {
    // Arrange — maxRetries of 1 means the first failure is already the last attempt
    mockGenerateContent.mockRejectedValueOnce(transient(429));

    // Act + Assert
    await expect(generateWorkoutPlan(profile, 1)).rejects.toThrow(
      /Failed to connect to Gemini AI after multiple attempts/,
    );
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it("propagates the failure through the import flow too", async () => {
    // Arrange
    mockGenerateContent.mockRejectedValueOnce(transient(500));

    // Act + Assert
    await expect(
      importAndCompleteWorkoutPlan(profile, {
        providedDomain: "strength",
        planDuration: 8,
        sourceText: "Squat 5x5",
      }),
    ).rejects.toThrow(/Failed to connect to Gemini AI/);
  });
});
