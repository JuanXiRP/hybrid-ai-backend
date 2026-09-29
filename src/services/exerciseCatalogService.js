// src/services/exerciseCatalogService.js
//
// The vendored free-exercise-db catalog (src/data/README.md) and the three things the plan flows
// need from it: a compact listing for the prompt, a lookup by id or name, and a pass that stamps
// every strength exercise of a plan with its catalog id.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Resolved from the working directory rather than import.meta.url: Jest transpiles to CommonJS,
// where import.meta is a syntax error. The server is always started from the repo root
// (`npm start`), and so is the test run.
const CATALOG_PATH = resolve(process.cwd(), "src/data/exercises.json");

// Categories the prompt may draw strength sessions from. Stretching and cardio never belong on a
// strength day.
const PROMPT_CATEGORIES = new Set([
  "strength",
  "powerlifting",
  "olympic weightlifting",
  "plyometrics",
  "strongman",
]);

// Catalog levels a given athlete level may be programmed. Anything else (advanced, unknown,
// missing) sees the whole catalog.
const LEVELS_BY_FITNESS_LEVEL = {
  beginner: new Set(["beginner", "intermediate"]),
  intermediate: new Set(["beginner", "intermediate"]),
};

let catalog = null;
let byNormalizedName = null;

export const getCatalog = () => {
  if (!catalog) {
    const list = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
    catalog = { list, byId: new Map(list.map((entry) => [entry.id, entry])) };
  }
  return catalog;
};

const normalizeName = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const getByNormalizedName = () => {
  if (!byNormalizedName) {
    byNormalizedName = new Map(
      getCatalog().list.map((entry) => [normalizeName(entry.name), entry]),
    );
  }
  return byNormalizedName;
};

/**
 * One line per exercise: `id | name | equipment | primaryMuscles | mechanic | level`.
 *
 * @param {{ fitnessLevel?: string }} [options]
 * @returns {string}
 */
export const buildPromptCatalog = ({ fitnessLevel } = {}) => {
  const allowedLevels = LEVELS_BY_FITNESS_LEVEL[fitnessLevel];
  return getCatalog()
    .list.filter(
      (entry) =>
        PROMPT_CATEGORIES.has(entry.category) &&
        (!allowedLevels || allowedLevels.has(entry.level)),
    )
    .map((entry) =>
      [
        entry.id,
        entry.name,
        entry.equipment ?? "-",
        (entry.primaryMuscles ?? []).join(", ") || "-",
        entry.mechanic ?? "-",
        entry.level ?? "-",
      ].join(" | "),
    )
    .join("\n");
};

/**
 * A catalog entry by exact id, else by normalised name, else null.
 *
 * @param {{ exerciseId?: string, name?: string }} exercise
 */
export const resolveExercise = ({ exerciseId, name } = {}) =>
  getCatalog().byId.get(exerciseId) ??
  getByNormalizedName().get(normalizeName(name)) ??
  null;

const normalizeGeneratedExercise = (exercise) => {
  const match = resolveExercise(exercise);
  return match
    ? { ...exercise, exerciseId: match.id, name: match.name }
    : { ...exercise, exerciseId: null };
};

// The athlete's own words win: the name is never rewritten and there is no name matching. An id
// the model volunteered survives only if it points at a real catalog entry.
const normalizeImportedExercise = (exercise) => ({
  ...exercise,
  exerciseId: getCatalog().byId.has(exercise.exerciseId)
    ? exercise.exerciseId
    : null,
});

/**
 * Stamps each exercise on a strength day with its catalog id. Pure: the input is not mutated.
 * Cardio and rest days pass through untouched.
 *
 * `unresolved` counts generated exercises the catalog could not resolve. Imported ones never
 * count, since keeping the athlete's own exercise without an id is the intended outcome.
 *
 * @param {Array} weeks
 * @returns {{ weeks: Array, unresolved: number }}
 */
export const normalizePlanExercises = (weeks) => {
  let unresolved = 0;

  const normalizedWeeks = weeks.map((week) => ({
    ...week,
    days: (week.days ?? []).map((day) => {
      if (day.workoutType !== "strength") return day;

      const imported = day.source === "imported";
      const exercises = (day.exercises ?? []).map((exercise) => {
        if (imported) return normalizeImportedExercise(exercise);
        const normalized = normalizeGeneratedExercise(exercise);
        if (normalized.exerciseId === null) unresolved += 1;
        return normalized;
      });
      return { ...day, exercises };
    }),
  }));

  return { weeks: normalizedWeeks, unresolved };
};
