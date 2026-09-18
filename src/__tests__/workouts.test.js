// Completed-session logging. Distinct from WorkoutPlan, which holds what the AI *planned*.
// POST /api/workouts/strength previously had no test at all — it was the only route in the app
// with zero coverage.

import mongoose from "mongoose";
import WorkoutRun from "../models/WorkoutRun.js";
import WorkoutStrength from "../models/WorkoutStrength.js";
import {
  makeRunWorkoutRequest,
  makeStrengthWorkoutRequest,
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
