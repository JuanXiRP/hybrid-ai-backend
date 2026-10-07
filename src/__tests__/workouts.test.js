// Completed-session logging. Distinct from WorkoutPlan, which holds what the AI *planned*.
// POST /api/workouts/strength previously had no test at all — it was the only route in the app
// with zero coverage.

import { randomUUID } from "crypto";
import mongoose from "mongoose";
import WorkoutRun from "../models/WorkoutRun.js";
import WorkoutStrength from "../models/WorkoutStrength.js";
import {
  makeRunWorkoutRequest,
  makeStrengthWorkoutRequest,
  makeUpsertStrengthWorkoutRequest,
} from "@test/helpers/api.js";
import { registerTestUser } from "@test/helpers/auth.js";
import { useTestDatabase } from "@test/helpers/db.js";

useTestDatabase();

const strengthPayload = (overrides = {}) => ({
  routineType: "Upper Body",
  exercises: [
    {
      exerciseName: "Bench Press",
      sets: 5,
      reps: 5,
      targetWeight: 80,
      targetRpe: 8,
    },
  ],
  ...overrides,
});

const runPayload = (overrides = {}) => ({
  distance: 10,
  duration: 3300,
  targetPace: 330,
  ...overrides,
});

describe("POST /api/workouts/strength", () => {
  it("requires authentication", async () => {
    // Act
    const res = await makeStrengthWorkoutRequest(null, strengthPayload());

    // Assert
    expect(res.status).toBe(401);
    expect(await WorkoutStrength.countDocuments()).toBe(0);
  });

  it("persists the session against the authenticated user", async () => {
    // Arrange
    const { token, id } = await registerTestUser();

    // Act
    const res = await makeStrengthWorkoutRequest(token, strengthPayload());

    // Assert
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const stored = await WorkoutStrength.findOne();
    expect(stored.routineType).toBe("Upper Body");
    expect(stored.exercises).toHaveLength(1);
    expect(stored.exercises[0].exerciseName).toBe("Bench Press");
    expect(String(stored.userId)).toBe(String(id));
  });

  // The controller spreads req.body and only then overrides userId. That ordering is the whole
  // defence against a client writing a session into someone else's history, so pin it shut.
  it("ignores a client-supplied userId", async () => {
    // Arrange
    const { token, id } = await registerTestUser();
    const someoneElse = new mongoose.Types.ObjectId();

    // Act
    const res = await makeStrengthWorkoutRequest(
      token,
      strengthPayload({ userId: someoneElse }),
    );

    // Assert
    expect(res.status).toBe(201);

    const stored = await WorkoutStrength.findOne();
    expect(String(stored.userId)).toBe(String(id));
    expect(String(stored.userId)).not.toBe(String(someoneElse));
  });

  // The plan markers are what let the coach hydrator know WHICH session was completed instead
  // of counting how many exist this week. They are optional so that an older client keeps
  // working, which makes both halves of this worth pinning.
  it("stores the plan markers when the client sends them", async () => {
    // Arrange
    const { token } = await registerTestUser();
    const planId = new mongoose.Types.ObjectId();

    // Act
    const res = await makeStrengthWorkoutRequest(
      token,
      strengthPayload({ planId, weekNumber: 2, dayIndex: 0 }),
    );

    // Assert
    expect(res.status).toBe(201);
    const stored = await WorkoutStrength.findOne();
    expect(String(stored.planId)).toBe(String(planId));
    expect(stored.weekNumber).toBe(2);
    expect(stored.dayIndex).toBe(0);
  });

  it("leaves the plan markers null for a client that does not send them", async () => {
    // Arrange
    const { token } = await registerTestUser();

    // Act
    await makeStrengthWorkoutRequest(token, strengthPayload());

    // Assert
    const stored = await WorkoutStrength.findOne();
    expect(stored.planId).toBeNull();
    expect(stored.weekNumber).toBeNull();
    expect(stored.dayIndex).toBeNull();
  });

  it("rejects a day index that cannot address a plan day", async () => {
    // Arrange
    const { token } = await registerTestUser();

    // Act
    const res = await makeStrengthWorkoutRequest(
      token,
      strengthPayload({ weekNumber: 0, dayIndex: -1 }),
    );

    // Assert
    expect(res.status).toBe(400);
    expect(await WorkoutStrength.countDocuments()).toBe(0);
  });

  it("answers 400 when a required field is missing", async () => {
    // Arrange — routineType is required by the schema
    const { token } = await registerTestUser();

    // Act
    const res = await makeStrengthWorkoutRequest(
      token,
      strengthPayload({ routineType: undefined }),
    );

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/Routine type is required/);
    expect(await WorkoutStrength.countDocuments()).toBe(0);
  });
});

// The idempotent create-or-edit path. The app mints `clientId` when a session starts, so a retried
// sync and an edit of a past workout both land on one document instead of duplicating it.
describe("PUT /api/workouts/strength/:clientId", () => {
  const aClientId = () => randomUUID();

  const upsertPayload = (overrides = {}) => ({
    ...strengthPayload(),
    startedAt: "2026-03-16T09:00:00.000Z",
    durationSec: 3600,
    notes: "Felt strong",
    weekNumber: 2,
    dayIndex: 0,
    ...overrides,
  });

  const perSetExercise = (overrides = {}) => ({
    exerciseName: "Barbell Bench Press",
    exerciseId: "Barbell_Bench_Press_-_Medium_Grip",
    notes: "Paused reps",
    sets: 2,
    reps: 5,
    targetWeight: 0,
    actualWeight: 82.5,
    targetRpe: 8,
    actualRpe: 9,
    setLogs: [
      { type: "warmup", weight: 40, reps: 10 },
      {
        type: "normal",
        weight: 82.5,
        reps: 5,
        targetReps: "5",
        targetRpe: 8,
        actualRpe: 9,
      },
    ],
    ...overrides,
  });

  it("requires authentication", async () => {
    // Act
    const res = await makeUpsertStrengthWorkoutRequest(
      null,
      aClientId(),
      upsertPayload(),
    );

    // Assert
    expect(res.status).toBe(401);
    expect(await WorkoutStrength.countDocuments()).toBe(0);
  });

  it("creates the session when the clientId is new", async () => {
    // Arrange
    const { token, id } = await registerTestUser();
    const clientId = aClientId();

    // Act
    const res = await makeUpsertStrengthWorkoutRequest(
      token,
      clientId,
      upsertPayload(),
    );

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const stored = await WorkoutStrength.findOne();
    expect(stored.clientId).toBe(clientId);
    expect(String(stored.userId)).toBe(String(id));
    expect(stored.routineType).toBe("Upper Body");
    expect(stored.startedAt.toISOString()).toBe("2026-03-16T09:00:00.000Z");
    expect(stored.durationSec).toBe(3600);
    expect(stored.notes).toBe("Felt strong");
    expect(stored.weekNumber).toBe(2);
    expect(stored.dayIndex).toBe(0);
  });

  it("stores the extra flag next to the day an extra session was done on", async () => {
    // Arrange
    const { token } = await registerTestUser();

    // Act
    const res = await makeUpsertStrengthWorkoutRequest(
      token,
      aClientId(),
      upsertPayload({ weekNumber: 2, dayIndex: 3, isExtra: true }),
    );

    // Assert
    expect(res.status).toBe(200);
    const stored = await WorkoutStrength.findOne();
    expect(stored.isExtra).toBe(true);
    expect(stored.weekNumber).toBe(2);
    expect(stored.dayIndex).toBe(3);
  });

  it("reads a session without the extra flag as a planned one", async () => {
    // Arrange
    const { token } = await registerTestUser();

    // Act
    await makeUpsertStrengthWorkoutRequest(token, aClientId(), upsertPayload());

    // Assert
    const stored = await WorkoutStrength.findOne();
    expect(stored.isExtra).toBe(false);
  });

  it("updates the same document on a second PUT instead of duplicating it", async () => {
    // Arrange
    const { token } = await registerTestUser();
    const clientId = aClientId();
    await makeUpsertStrengthWorkoutRequest(token, clientId, upsertPayload());

    // Act
    const res = await makeUpsertStrengthWorkoutRequest(
      token,
      clientId,
      upsertPayload({ notes: "Edited afterwards", durationSec: 4200 }),
    );

    // Assert
    expect(res.status).toBe(200);
    expect(await WorkoutStrength.countDocuments()).toBe(1);

    const stored = await WorkoutStrength.findOne();
    expect(stored.notes).toBe("Edited afterwards");
    expect(stored.durationSec).toBe(4200);
  });

  it("replaces the exercises on an edit rather than appending to them", async () => {
    // Arrange
    const { token } = await registerTestUser();
    const clientId = aClientId();
    await makeUpsertStrengthWorkoutRequest(
      token,
      clientId,
      upsertPayload({ exercises: [perSetExercise(), perSetExercise()] }),
    );

    // Act
    await makeUpsertStrengthWorkoutRequest(
      token,
      clientId,
      upsertPayload({ exercises: [perSetExercise()] }),
    );

    // Assert
    const stored = await WorkoutStrength.findOne();
    expect(stored.exercises).toHaveLength(1);
  });

  it("collapses two concurrent first PUTs for one clientId into one document", async () => {
    // Arrange — a retry racing its original both miss the find and both try to insert
    const { token } = await registerTestUser();
    const clientId = aClientId();

    // Act
    const [first, second] = await Promise.all([
      makeUpsertStrengthWorkoutRequest(token, clientId, upsertPayload()),
      makeUpsertStrengthWorkoutRequest(token, clientId, upsertPayload()),
    ]);

    // Assert
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await WorkoutStrength.countDocuments()).toBe(1);
  });

  // The clientId is only unique per athlete. If it were global, guessing or replaying someone
  // else's id would let a caller overwrite their log; scoping the filter by userId is the defence.
  it("never touches another athlete's session that shares the clientId", async () => {
    // Arrange
    const owner = await registerTestUser();
    const other = await registerTestUser();
    const clientId = aClientId();
    await makeUpsertStrengthWorkoutRequest(
      owner.token,
      clientId,
      upsertPayload({ notes: "Owner's notes" }),
    );

    // Act
    const res = await makeUpsertStrengthWorkoutRequest(
      other.token,
      clientId,
      upsertPayload({ notes: "Other's notes" }),
    );

    // Assert
    expect(res.status).toBe(200);
    expect(await WorkoutStrength.countDocuments()).toBe(2);

    const ownerDoc = await WorkoutStrength.findOne({ userId: owner.id });
    const otherDoc = await WorkoutStrength.findOne({ userId: other.id });
    expect(ownerDoc.notes).toBe("Owner's notes");
    expect(otherDoc.notes).toBe("Other's notes");
  });

  it("answers 400 when the clientId is not a UUID", async () => {
    // Arrange
    const { token } = await registerTestUser();

    // Act
    const res = await makeUpsertStrengthWorkoutRequest(
      token,
      "not-a-uuid",
      upsertPayload(),
    );

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(await WorkoutStrength.countDocuments()).toBe(0);
  });

  it("persists the exercise id, notes and per-set logs", async () => {
    // Arrange
    const { token } = await registerTestUser();
    const exercise = perSetExercise();

    // Act
    const res = await makeUpsertStrengthWorkoutRequest(
      token,
      aClientId(),
      upsertPayload({ exercises: [exercise] }),
    );

    // Assert
    expect(res.status).toBe(200);

    const [stored] = (await WorkoutStrength.findOne().lean()).exercises;
    expect(stored.exerciseId).toBe(exercise.exerciseId);
    expect(stored.notes).toBe(exercise.notes);
    expect(stored.setLogs).toEqual(exercise.setLogs);
  });

  it("defaults a set's type to normal when the client leaves it out", async () => {
    // Arrange
    const { token } = await registerTestUser();
    const exercise = perSetExercise({ setLogs: [{ weight: 60, reps: 8 }] });

    // Act
    await makeUpsertStrengthWorkoutRequest(
      token,
      aClientId(),
      upsertPayload({ exercises: [exercise] }),
    );

    // Assert
    const [stored] = (await WorkoutStrength.findOne().lean()).exercises;
    expect(stored.setLogs).toEqual([{ type: "normal", weight: 60, reps: 8 }]);
  });

  it("rejects a set type outside the enum", async () => {
    // Arrange
    const { token } = await registerTestUser();
    const exercise = perSetExercise({
      setLogs: [{ type: "superset", weight: 60, reps: 8 }],
    });

    // Act
    const res = await makeUpsertStrengthWorkoutRequest(
      token,
      aClientId(),
      upsertPayload({ exercises: [exercise] }),
    );

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(await WorkoutStrength.countDocuments()).toBe(0);
  });

  it("stores an exercise from a client that sends no per-set detail", async () => {
    // Arrange — the legacy exercise shape must keep working on the new route
    const { token } = await registerTestUser();

    // Act
    const res = await makeUpsertStrengthWorkoutRequest(
      token,
      aClientId(),
      strengthPayload(),
    );

    // Assert
    expect(res.status).toBe(200);
    const [stored] = (await WorkoutStrength.findOne().lean()).exercises;
    expect(stored.exerciseId).toBeNull();
    expect(stored.setLogs).toEqual([]);
  });

  it("ignores a client-supplied userId", async () => {
    // Arrange
    const { token, id } = await registerTestUser();
    const someoneElse = new mongoose.Types.ObjectId();

    // Act
    const res = await makeUpsertStrengthWorkoutRequest(
      token,
      aClientId(),
      upsertPayload({ userId: someoneElse }),
    );

    // Assert
    expect(res.status).toBe(200);
    const stored = await WorkoutStrength.findOne();
    expect(String(stored.userId)).toBe(String(id));
  });

  it("ignores a client-supplied planId and clientId", async () => {
    // Arrange
    const { token } = await registerTestUser();
    const clientId = aClientId();

    // Act
    await makeUpsertStrengthWorkoutRequest(
      token,
      clientId,
      upsertPayload({
        planId: new mongoose.Types.ObjectId(),
        clientId: aClientId(),
      }),
    );

    // Assert
    const stored = await WorkoutStrength.findOne();
    expect(stored.planId).toBeNull();
    expect(stored.clientId).toBe(clientId);
  });

  it("answers 400 when a required field is missing, and creates nothing", async () => {
    // Arrange — routineType is required, and an update validator would not notice its absence
    const { token } = await registerTestUser();

    // Act
    const res = await makeUpsertStrengthWorkoutRequest(
      token,
      aClientId(),
      upsertPayload({ routineType: undefined }),
    );

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Routine type is required/);
    expect(await WorkoutStrength.countDocuments()).toBe(0);
  });

  it("answers 400 for a day index that cannot address a plan day", async () => {
    // Arrange
    const { token } = await registerTestUser();

    // Act
    const res = await makeUpsertStrengthWorkoutRequest(
      token,
      aClientId(),
      upsertPayload({ weekNumber: 0, dayIndex: -1 }),
    );

    // Assert
    expect(res.status).toBe(400);
    expect(await WorkoutStrength.countDocuments()).toBe(0);
  });

  it("does not stop legacy POST logs, which carry no clientId, from coexisting", async () => {
    // Arrange — the unique index is partial, so missing values must not collide
    const { token } = await registerTestUser();

    // Act
    const first = await makeStrengthWorkoutRequest(token, strengthPayload());
    const second = await makeStrengthWorkoutRequest(token, strengthPayload());

    // Assert
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await WorkoutStrength.countDocuments()).toBe(2);
  });
});

describe("POST /api/workouts/run", () => {
  it("requires authentication", async () => {
    // Act
    const res = await makeRunWorkoutRequest(null, runPayload());

    // Assert
    expect(res.status).toBe(401);
  });

  it("persists the run against the authenticated user", async () => {
    // Arrange
    const { token, id } = await registerTestUser();

    // Act
    const res = await makeRunWorkoutRequest(token, runPayload());

    // Assert
    expect(res.status).toBe(201);

    const stored = await WorkoutRun.findOne();
    expect(stored.distance).toBe(10);
    // Pace is stored strictly as seconds per kilometre, never as a formatted string.
    expect(stored.targetPace).toBe(330);
    expect(String(stored.userId)).toBe(String(id));
  });

  it("stores the plan markers on a run when the client sends them", async () => {
    // Arrange
    const { token } = await registerTestUser();
    const planId = new mongoose.Types.ObjectId();

    // Act
    const res = await makeRunWorkoutRequest(
      token,
      runPayload({ planId, weekNumber: 1, dayIndex: 2 }),
    );

    // Assert
    expect(res.status).toBe(201);
    const stored = await WorkoutRun.findOne();
    expect(String(stored.planId)).toBe(String(planId));
    expect(stored.weekNumber).toBe(1);
    expect(stored.dayIndex).toBe(2);
  });

  it("stores the extra flag on a run the athlete added on top of the plan", async () => {
    // Arrange
    const { token } = await registerTestUser();

    // Act
    const res = await makeRunWorkoutRequest(
      token,
      runPayload({ weekNumber: 1, dayIndex: 4, isExtra: true }),
    );

    // Assert
    expect(res.status).toBe(201);
    const stored = await WorkoutRun.findOne();
    expect(stored.isExtra).toBe(true);
    expect(stored.dayIndex).toBe(4);
  });

  it("leaves the plan markers null on a run that omits them", async () => {
    // Arrange
    const { token } = await registerTestUser();

    // Act
    await makeRunWorkoutRequest(token, runPayload());

    // Assert
    const stored = await WorkoutRun.findOne();
    expect(stored.weekNumber).toBeNull();
    expect(stored.dayIndex).toBeNull();
  });

  it("ignores a client-supplied userId", async () => {
    // Arrange
    const { token, id } = await registerTestUser();
    const someoneElse = new mongoose.Types.ObjectId();

    // Act
    await makeRunWorkoutRequest(token, runPayload({ userId: someoneElse }));

    // Assert
    const stored = await WorkoutRun.findOne();
    expect(String(stored.userId)).toBe(String(id));
  });

  // The plan markers are what let the coach hydrator know WHICH session was completed instead
  // of counting how many exist this week. They are optional so that an older client keeps
  // working, which makes both halves of this worth pinning.
  it("stores the plan markers when the client sends them", async () => {
    // Arrange
    const { token } = await registerTestUser();
    const planId = new mongoose.Types.ObjectId();

    // Act
    const res = await makeStrengthWorkoutRequest(
      token,
      strengthPayload({ planId, weekNumber: 2, dayIndex: 0 }),
    );

    // Assert
    expect(res.status).toBe(201);
    const stored = await WorkoutStrength.findOne();
    expect(String(stored.planId)).toBe(String(planId));
    expect(stored.weekNumber).toBe(2);
    expect(stored.dayIndex).toBe(0);
  });

  it("leaves the plan markers null for a client that does not send them", async () => {
    // Arrange
    const { token } = await registerTestUser();

    // Act
    await makeStrengthWorkoutRequest(token, strengthPayload());

    // Assert
    const stored = await WorkoutStrength.findOne();
    expect(stored.planId).toBeNull();
    expect(stored.weekNumber).toBeNull();
    expect(stored.dayIndex).toBeNull();
  });

  it("rejects a day index that cannot address a plan day", async () => {
    // Arrange
    const { token } = await registerTestUser();

    // Act
    const res = await makeStrengthWorkoutRequest(
      token,
      strengthPayload({ weekNumber: 0, dayIndex: -1 }),
    );

    // Assert
    expect(res.status).toBe(400);
    expect(await WorkoutStrength.countDocuments()).toBe(0);
  });

  it("answers 400 when a required field is missing", async () => {
    // Arrange — distance is required by the schema
    const { token } = await registerTestUser();

    // Act
    const res = await makeRunWorkoutRequest(
      token,
      runPayload({ distance: undefined }),
    );

    // Assert
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Distance is required/);
    expect(await WorkoutRun.countDocuments()).toBe(0);
  });
});
