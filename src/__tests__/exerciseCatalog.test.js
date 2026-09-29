import {
  buildPromptCatalog,
  getCatalog,
  normalizePlanExercises,
  resolveExercise,
} from "../services/exerciseCatalogService.js";

// Real entries, read from the vendored catalog, so no suite owns a literal id or name.
const { list } = getCatalog();
const strengthEntry = list.find((entry) => entry.category === "strength");
const otherStrengthEntry = list.find(
  (entry) => entry.category === "strength" && entry.id !== strengthEntry.id,
);
const stretchingEntry = list.find((entry) => entry.category === "stretching");
const cardioEntry = list.find((entry) => entry.category === "cardio");
const expertEntry = list.find(
  (entry) => entry.level === "expert" && entry.category === "strength",
);

const promptIds = (options) =>
  buildPromptCatalog(options)
    .split("\n")
    .map((line) => line.split(" | ")[0]);

const exercise = (overrides = {}) => ({
  name: "anything",
  sets: "3",
  reps: "8",
  rpe: "7",
  ...overrides,
});

const planOf = (day) => [{ weekNumber: 1, days: [day] }];

describe("getCatalog", () => {
  it("loads entries that all carry an id and a name, with unique ids", () => {
    // Assert
    expect(list.length).toBeGreaterThan(0);
    expect(
      list.every((e) => typeof e.id === "string" && typeof e.name === "string"),
    ).toBe(true);
    expect(getCatalog().byId.size).toBe(list.length);
  });

  it("is loaded once and reused", () => {
    // Act / Assert
    expect(getCatalog()).toBe(getCatalog());
  });
});

describe("buildPromptCatalog", () => {
  it("writes one pipe-separated line per exercise", () => {
    // Act
    const lines = buildPromptCatalog().split("\n");

    // Assert
    expect(lines[0].split(" | ")).toHaveLength(6);
  });

  it("drops stretching and cardio", () => {
    // Act
    const ids = promptIds();

    // Assert
    expect(ids).toContain(strengthEntry.id);
    expect(ids).not.toContain(stretchingEntry.id);
    expect(ids).not.toContain(cardioEntry.id);
  });

  it("hides expert exercises from beginners and intermediates", () => {
    // Act / Assert
    expect(promptIds({ fitnessLevel: "beginner" })).not.toContain(
      expertEntry.id,
    );
    expect(promptIds({ fitnessLevel: "intermediate" })).not.toContain(
      expertEntry.id,
    );
  });

  it.each(["advanced", "something-else", undefined])(
    "shows every level for fitnessLevel %s",
    (fitnessLevel) => {
      // Act
      const ids = promptIds({ fitnessLevel });

      // Assert
      expect(ids).toContain(expertEntry.id);
    },
  );

  it("prints a placeholder for entries with no equipment or mechanic", () => {
    // Arrange
    const sparse = list.find(
      (e) =>
        e.equipment === null &&
        e.mechanic === null &&
        !["stretching", "cardio"].includes(e.category),
    );

    // Act
    const line = buildPromptCatalog()
      .split("\n")
      .find((l) => l.startsWith(`${sparse.id} | `));

    // Assert
    expect(line.split(" | ")[2]).toBe("-");
    expect(line.split(" | ")[4]).toBe("-");
  });
});

describe("resolveExercise", () => {
  it("finds an entry by exact id", () => {
    // Act / Assert
    expect(resolveExercise({ exerciseId: strengthEntry.id })).toBe(
      strengthEntry,
    );
  });

  it("finds an entry by name ignoring case, punctuation and spacing", () => {
    // Arrange
    const sloppy = `  ${strengthEntry.name.toUpperCase().replace(/\s/g, "   ")}!! `;

    // Act / Assert
    expect(resolveExercise({ name: sloppy })).toBe(strengthEntry);
  });

  it("prefers the id over the name", () => {
    // Act / Assert
    expect(
      resolveExercise({
        exerciseId: strengthEntry.id,
        name: otherStrengthEntry.name,
      }),
    ).toBe(strengthEntry);
  });

  it("returns null when nothing matches", () => {
    // Act / Assert
    expect(
      resolveExercise({ exerciseId: "nope", name: "not a real movement" }),
    ).toBeNull();
    expect(resolveExercise()).toBeNull();
  });
});

describe("normalizePlanExercises", () => {
  it("resolves a generated exercise and rewrites its name to the canonical one", () => {
    // Arrange
    const weeks = planOf({
      workoutType: "strength",
      exercises: [
        exercise({
          exerciseId: strengthEntry.id,
          name: `${strengthEntry.name} (my version)`,
        }),
      ],
    });

    // Act
    const { weeks: result, unresolved } = normalizePlanExercises(weeks);

    // Assert
    expect(result[0].days[0].exercises[0]).toEqual(
      expect.objectContaining({
        exerciseId: strengthEntry.id,
        name: strengthEntry.name,
      }),
    );
    expect(unresolved).toBe(0);
  });

  it("falls back to the name when a generated id is missing", () => {
    // Arrange
    const weeks = planOf({
      workoutType: "strength",
      source: "generated",
      exercises: [exercise({ name: strengthEntry.name.toLowerCase() })],
    });

    // Act
    const { weeks: result } = normalizePlanExercises(weeks);

    // Assert
    expect(result[0].days[0].exercises[0].exerciseId).toBe(strengthEntry.id);
  });

  it("nulls an invalid generated id, keeps the name and counts it", () => {
    // Arrange
    const weeks = planOf({
      workoutType: "strength",
      exercises: [exercise({ exerciseId: "made_up", name: "Invented Lift" })],
    });

    // Act
    const { weeks: result, unresolved } = normalizePlanExercises(weeks);

    // Assert
    expect(result[0].days[0].exercises[0]).toEqual(
      expect.objectContaining({ exerciseId: null, name: "Invented Lift" }),
    );
    expect(unresolved).toBe(1);
  });

  it("never rewrites the name of an imported exercise", () => {
    // Arrange
    const athletesName = "Squats, my coach's way";
    const weeks = planOf({
      workoutType: "strength",
      source: "imported",
      exercises: [
        exercise({ exerciseId: strengthEntry.id, name: athletesName }),
      ],
    });

    // Act
    const { weeks: result, unresolved } = normalizePlanExercises(weeks);

    // Assert
    expect(result[0].days[0].exercises[0]).toEqual(
      expect.objectContaining({
        exerciseId: strengthEntry.id,
        name: athletesName,
      }),
    );
    expect(unresolved).toBe(0);
  });

  it("nulls an invalid imported id, without name matching or counting it", () => {
    // Arrange
    const weeks = planOf({
      workoutType: "strength",
      source: "imported",
      exercises: [
        exercise({ exerciseId: "made_up", name: strengthEntry.name }),
        exercise({ name: strengthEntry.name }),
      ],
    });

    // Act
    const { weeks: result, unresolved } = normalizePlanExercises(weeks);

    // Assert
    expect(result[0].days[0].exercises.map((e) => e.exerciseId)).toEqual([
      null,
      null,
    ]);
    expect(unresolved).toBe(0);
  });

  it("leaves cardio and rest days untouched", () => {
    // Arrange
    const cardio = {
      workoutType: "cardio",
      exercises: [exercise({ name: "Easy run", reps: "8 km" })],
    };
    const rest = { workoutType: "rest", exercises: [] };
    const weeks = [{ weekNumber: 1, days: [cardio, rest] }];

    // Act
    const { weeks: result, unresolved } = normalizePlanExercises(weeks);

    // Assert
    expect(result[0].days).toEqual([cardio, rest]);
    expect(result[0].days[0].exercises[0]).not.toHaveProperty("exerciseId");
    expect(unresolved).toBe(0);
  });

  it("tolerates weeks without days and days without exercises", () => {
    // Act
    const { weeks: result, unresolved } = normalizePlanExercises([
      { weekNumber: 1 },
      { weekNumber: 2, days: [{ workoutType: "strength" }] },
    ]);

    // Assert
    expect(result[0].days).toEqual([]);
    expect(result[1].days[0].exercises).toEqual([]);
    expect(unresolved).toBe(0);
  });

  it("does not mutate its input", () => {
    // Arrange
    const weeks = planOf({
      workoutType: "strength",
      exercises: [exercise({ name: strengthEntry.name.toLowerCase() })],
    });
    const snapshot = JSON.parse(JSON.stringify(weeks));

    // Act
    normalizePlanExercises(weeks);

    // Assert
    expect(weeks).toEqual(snapshot);
  });
});
