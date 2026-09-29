// The controller's job here is to ground the plan in the exercise catalog before persisting it.
// Gemini itself is mocked; the prompt is covered by geminiService.test.js.
jest.mock("../services/geminiService.js", () =>
  require("@test/mocks/geminiService.js").create(),
);

import WorkoutPlan from "../models/WorkoutPlan.js";
import { generateWorkoutPlan } from "../services/geminiService.js";
import { getCatalog } from "../services/exerciseCatalogService.js";
import { makeGeneratePlanRequest } from "@test/helpers/api.js";
import { registerTestUser } from "@test/helpers/auth.js";
import { useTestDatabase } from "@test/helpers/db.js";
import { silenceConsole } from "@test/helpers/console.js";
import { resetGeminiMocks } from "@test/mocks/geminiService.js";

useTestDatabase();

const consoleSpies = silenceConsole();

const catalogEntry = getCatalog().list.find((e) => e.category === "strength");

const planFrom = (exercises) =>
  JSON.stringify({
    durationWeeks: 4,
    goal: "both",
    weeks: [
      {
        weekNumber: 1,
        days: [
          { dayName: "Lower Body", workoutType: "strength", exercises },
          {
            dayName: "Zone 2 Run",
            workoutType: "cardio",
            exercises: [
              { name: "Easy run", sets: "1", reps: "8 km", rpe: "4" },
            ],
          },
        ],
      },
    ],
  });

beforeEach(() => {
  resetGeminiMocks();
});

describe("POST /api/ai/generate-plan — exercise catalog", () => {
  it("persists the resolved id and the canonical name", async () => {
    // Arrange
    const { token } = await registerTestUser();
    generateWorkoutPlan.mockResolvedValue(
      planFrom([
        {
          name: `${catalogEntry.name} (variation)`,
          exerciseId: catalogEntry.id,
          sets: "4",
          reps: "6",
          rpe: "8",
        },
      ]),
    );

    // Act
    const res = await makeGeneratePlanRequest(token, {
      planDuration: 4,
      goal: "both",
    });

    // Assert
    expect(res.status).toBe(201);
    const stored = await WorkoutPlan.findOne().lean();
    const [lift] = stored.weeks[0].days[0].exercises;
    expect(lift).toEqual(
      expect.objectContaining({
        exerciseId: catalogEntry.id,
        name: catalogEntry.name,
      }),
    );
    const [run] = stored.weeks[0].days[1].exercises;
    expect(run.exerciseId).toBeNull();
  });

  it("keeps an unresolved exercise with a null id and warns without naming it", async () => {
    // Arrange
    const { token } = await registerTestUser();
    const invented = "Invented Lift Nobody Has Heard Of";
    generateWorkoutPlan.mockResolvedValue(
      planFrom([{ name: invented, sets: "3", reps: "10", rpe: "7" }]),
    );

    // Act
    const res = await makeGeneratePlanRequest(token, {
      planDuration: 4,
      goal: "both",
    });

    // Assert
    expect(res.status).toBe(201);
    const stored = await WorkoutPlan.findOne().lean();
    expect(stored.weeks[0].days[0].exercises[0]).toEqual(
      expect.objectContaining({ name: invented, exerciseId: null }),
    );
    expect(consoleSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining("1 generated exercise(s)"),
    );
    expect(consoleSpies.warn).not.toHaveBeenCalledWith(
      expect.stringContaining(invented),
    );
  });
});
