// Mock the Gemini service so the import endpoint never hits the real API. The controller's job
// here is payload validation, profile resolution and persistence — the prompt itself is covered
// by geminiService.test.js.
jest.mock("../services/geminiService.js", () =>
  require("@test/mocks/geminiService.js").create(),
);

import User from "../models/User.js";
import WorkoutPlan from "../models/WorkoutPlan.js";
import { importAndCompleteWorkoutPlan } from "../services/geminiService.js";
import {
  makeAuthenticatedChatRequest,
  makeImportPlanRequest,
} from "@test/helpers/api.js";
import { registerTestUser } from "@test/helpers/auth.js";
import { useTestDatabase } from "@test/helpers/db.js";
import { silenceConsole } from "@test/helpers/console.js";
import { resetGeminiMocks } from "@test/mocks/geminiService.js";

useTestDatabase();

// The failure-mode tests drive the controller's catch block, which logs before responding.
silenceConsole();

// A minimal merged macrocycle: one imported gym day, one generated run, one rest day.
const MERGED_PLAN = {
  durationWeeks: 4,
  goal: "both",
  weeks: [
    {
      weekNumber: 1,
      days: [
        {
          dayName: "Lower Body",
          workoutType: "strength",
          source: "imported",
          exercises: [{ name: "Back Squat", sets: "5", reps: "5", rpe: "8" }],
        },
        {
          dayName: "Zone 2 Run",
          workoutType: "cardio",
          source: "generated",
          exercises: [{ name: "Easy run", sets: "1", reps: "8 km", rpe: "4" }],
        },
        {
          dayName: "Rest",
          workoutType: "rest",
          source: "generated",
          exercises: [],
        },
      ],
    },
  ],
};

// A tiny but syntactically valid base64 PDF header.
const PDF_BASE64 = "JVBERi0xLjQK";

const registerImporter = () => registerTestUser({ name: "Import User" });

// mockReset (not just the global clearAllMocks) because several tests queue their own resolved
// value; reset also drops the implementation, so the default is reinstalled right after.
beforeEach(() => {
  resetGeminiMocks();
  importAndCompleteWorkoutPlan.mockResolvedValue(JSON.stringify(MERGED_PLAN));
});

describe("POST /api/ai/import-plan — payload validation", () => {
  it("requires authentication", async () => {
    // Act
    const res = await makeImportPlanRequest(null, {
      providedDomain: "strength",
      sourceText: "x",
    });

    // Assert
    expect(res.status).toBe(401);
  });

  it("rejects a missing or unknown providedDomain", async () => {
    // Arrange
    const { token } = await registerImporter();

    // Act
    const missing = await makeImportPlanRequest(token, {
      sourceText: "Squat 5x5",
    });
    const unknown = await makeImportPlanRequest(token, {
      providedDomain: "yoga",
      sourceText: "Squat 5x5",
    });

    // Assert
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/providedDomain/);
    expect(unknown.status).toBe(400);
    expect(importAndCompleteWorkoutPlan).not.toHaveBeenCalled();
  });

  it("rejects a request with neither text nor attachments", async () => {
    // Arrange
    const { token } = await registerImporter();

    // Act
    const res = await makeImportPlanRequest(token, {
      providedDomain: "strength",
      sourceText: "   ",
    });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sourceText|attachment/i);
    expect(importAndCompleteWorkoutPlan).not.toHaveBeenCalled();
  });

  it("rejects an attachment whose mime type is not allowed", async () => {
    // Arrange
    const { token } = await registerImporter();

    // Act
    const res = await makeImportPlanRequest(token, {
      providedDomain: "strength",
      attachments: [{ mimeType: "application/zip", data: PDF_BASE64 }],
    });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Unsupported attachment type/);
    expect(importAndCompleteWorkoutPlan).not.toHaveBeenCalled();
  });

  it("rejects attachment data that is not base64", async () => {
    // Arrange
    const { token } = await registerImporter();

    // Act
    const res = await makeImportPlanRequest(token, {
      providedDomain: "strength",
      attachments: [{ mimeType: "application/pdf", data: "not base64!!" }],
    });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/base64/);
  });

  it("rejects an attachment with no mimeType", async () => {
    // Arrange
    const { token } = await registerImporter();

    // Act
    const res = await makeImportPlanRequest(token, {
      providedDomain: "strength",
      attachments: [{ data: PDF_BASE64 }],
    });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/mimeType/i);
    expect(importAndCompleteWorkoutPlan).not.toHaveBeenCalled();
  });

  it("rejects sourceText longer than the 20000 character cap", async () => {
    // Arrange
    const { token } = await registerImporter();

    // Act
    const res = await makeImportPlanRequest(token, {
      providedDomain: "strength",
      sourceText: "x".repeat(20001),
    });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/20000/);
    expect(importAndCompleteWorkoutPlan).not.toHaveBeenCalled();
  });

  it("rejects more than five attachments", async () => {
    // Arrange
    const { token } = await registerImporter();

    // Act
    const res = await makeImportPlanRequest(token, {
      providedDomain: "cardio",
      attachments: Array.from({ length: 6 }, () => ({
        mimeType: "image/png",
        data: PDF_BASE64,
      })),
    });

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/At most 5 attachments/);
  });
});

describe("POST /api/ai/import-plan — happy path", () => {
  it("forwards the source material and persists the merged plan", async () => {
    // Arrange
    const { token, email } = await registerImporter();

    // Act
    const res = await makeImportPlanRequest(token, {
      providedDomain: "strength",
      planDuration: 4,
      goal: "both",
      sourceText: "Day A: Back Squat 5x5 @RPE8",
      attachments: [{ mimeType: "application/pdf", data: PDF_BASE64 }],
    });

    // Assert
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    // The service receives the material as explicit arguments...
    expect(importAndCompleteWorkoutPlan).toHaveBeenCalledWith(
      expect.objectContaining({ email }),
      expect.objectContaining({
        providedDomain: "strength",
        planDuration: 4,
        sourceText: "Day A: Back Squat 5x5 @RPE8",
        attachments: expect.arrayContaining([
          expect.objectContaining({ mimeType: "application/pdf" }),
        ]),
      }),
    );

    // ...and never smuggled into the profile, which would put raw uploads in the prompt twice.
    expect(importAndCompleteWorkoutPlan).not.toHaveBeenCalledWith(
      expect.objectContaining({ sourceText: expect.anything() }),
      expect.anything(),
    );
    expect(importAndCompleteWorkoutPlan).not.toHaveBeenCalledWith(
      expect.objectContaining({ attachments: expect.anything() }),
      expect.anything(),
    );

    const stored = await WorkoutPlan.findOne();
    expect(stored.origin).toBe("imported");
    expect(stored.durationWeeks).toBe(4);
    const days = stored.weeks[0].days;
    expect(days.map((d) => d.source)).toEqual([
      "imported",
      "generated",
      "generated",
    ]);
    expect(days[0].workoutType).toBe("strength");
    expect(days[1].workoutType).toBe("cardio");
  });

  it("falls back to the persisted profile for planDuration and goal", async () => {
    // Arrange
    const { token, email } = await registerImporter();
    await User.updateOne({ email }, { planDuration: 12, goal: "endurance" });

    // Act
    await makeImportPlanRequest(token, {
      providedDomain: "cardio",
      sourceText: "Tue: 8km easy",
    });

    // Assert
    expect(importAndCompleteWorkoutPlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ planDuration: 12 }),
    );

    const stored = await WorkoutPlan.findOne();
    expect(stored.durationWeeks).toBe(12);
    expect(stored.goal).toBe("endurance");
  });

  it('defaults source to "generated" when the model omits it', async () => {
    // Arrange
    const { token } = await registerImporter();
    importAndCompleteWorkoutPlan.mockResolvedValue(
      JSON.stringify({
        weeks: [
          {
            weekNumber: 1,
            days: [{ dayName: "Run", workoutType: "cardio", exercises: [] }],
          },
        ],
      }),
    );

    // Act
    const res = await makeImportPlanRequest(token, {
      providedDomain: "strength",
      planDuration: 4,
      goal: "both",
      sourceText: "Squat 5x5",
    });

    // Assert
    expect(res.status).toBe(201);
    const stored = await WorkoutPlan.findOne();
    expect(stored.weeks[0].days[0].source).toBe("generated");
  });
});

describe("POST /api/ai/import-plan — failure modes", () => {
  it("returns 422 when the model finds no plan in the material", async () => {
    // Arrange
    const { token } = await registerImporter();
    importAndCompleteWorkoutPlan.mockResolvedValue(
      JSON.stringify({ durationWeeks: 4, goal: "both", weeks: [] }),
    );

    // Act
    const res = await makeImportPlanRequest(token, {
      providedDomain: "strength",
      planDuration: 4,
      sourceText: "shopping list: milk, eggs",
    });

    // Assert
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(await WorkoutPlan.countDocuments()).toBe(0);
  });

  it("returns 500 when the AI call fails", async () => {
    // Arrange
    const { token } = await registerImporter();
    importAndCompleteWorkoutPlan.mockRejectedValue(
      new Error("Gemini exploded"),
    );

    // Act
    const res = await makeImportPlanRequest(token, {
      providedDomain: "strength",
      sourceText: "Squat 5x5",
    });

    // Assert
    expect(res.status).toBe(500);
    expect(await WorkoutPlan.countDocuments()).toBe(0);
  });

  it("consumes the same free-plan quota as generation", async () => {
    // Arrange
    const { token, email } = await registerImporter();
    const user = await User.findOne({ email });
    await WorkoutPlan.create({
      userId: user._id,
      durationWeeks: 8,
      goal: "both",
      weeks: [],
    });

    // Act
    const res = await makeImportPlanRequest(token, {
      providedDomain: "strength",
      sourceText: "Squat 5x5",
    });

    // Assert
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("PLAN_LIMIT_REACHED");
    expect(importAndCompleteWorkoutPlan).not.toHaveBeenCalled();
  });
});

describe("POST /api/ai/import-plan — body size", () => {
  it("accepts a payload far larger than the 100 kb global express.json limit", async () => {
    // Arrange
    const { token } = await registerImporter();
    // ~600 kB of base64: rejected by the default parser, fine for this route's 12 MB one.
    const bigButLegal = "A".repeat(600 * 1024);

    // Act
    const res = await makeImportPlanRequest(token, {
      providedDomain: "strength",
      planDuration: 4,
      goal: "both",
      attachments: [{ mimeType: "application/pdf", data: bigButLegal }],
    });

    // Assert
    expect(res.status).toBe(201);
  });

  it("still enforces the tight limit on other routes", async () => {
    // Arrange
    const { token } = await registerImporter();

    // Act
    const res = await makeAuthenticatedChatRequest(token, {
      message: "x".repeat(200 * 1024),
    });

    // Assert
    expect(res.status).toBe(413);
  });
});
