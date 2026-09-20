import mongoose from "mongoose";
import WorkoutPlan from "../models/WorkoutPlan.js";
import WorkoutRun from "../models/WorkoutRun.js";
import WorkoutStrength from "../models/WorkoutStrength.js";
import {
  findActivePlan,
  findRecentRunSessions,
  findRecentStrengthSessions,
} from "../repositories/trainingRepository.js";
import { useTestDatabase } from "@test/helpers/db.js";

useTestDatabase();

const anUserId = () => new mongoose.Types.ObjectId();
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const seedPlan = (userId, overrides = {}) =>
  WorkoutPlan.create({
    userId,
    durationWeeks: 8,
    goal: "both",
    weeks: [{ weekNumber: 1, days: [] }],
    ...overrides,
  });

describe("findActivePlan", () => {
  it("returns the newest plan as a plain object", async () => {
    // Arrange
    const userId = anUserId();
    await seedPlan(userId, { goal: "strength" });
    await seedPlan(userId, { goal: "endurance" });

    // Act
    const plan = await findActivePlan(userId);

    // Assert
    expect(plan.goal).toBe("endurance");
    expect(plan.save).toBeUndefined();
  });

  it("ignores a deactivated plan", async () => {
    // Arrange
    const userId = anUserId();
    await seedPlan(userId, { goal: "strength" });
    await seedPlan(userId, { goal: "endurance", active: false });

    // Act
    const plan = await findActivePlan(userId);

    // Assert
    expect(plan.goal).toBe("strength");
  });

  it("returns null for an athlete with no plan", async () => {
    // Arrange / Act
    const plan = await findActivePlan(anUserId());

    // Assert
    expect(plan).toBeNull();
  });
});

describe("findRecentStrengthSessions", () => {
  it("returns sessions inside the window, newest first", async () => {
    // Arrange
    const userId = anUserId();
    await WorkoutStrength.create([
      { userId, date: daysAgo(30), routineType: "old" },
      { userId, date: daysAgo(5), routineType: "older" },
      { userId, date: daysAgo(1), routineType: "newest" },
    ]);

    // Act
    const sessions = await findRecentStrengthSessions(userId, daysAgo(21), 10);

    // Assert
    expect(sessions.map((session) => session.routineType)).toEqual([
      "newest",
      "older",
    ]);
  });

  it("caps the result at the limit", async () => {
    // Arrange
    const userId = anUserId();
    await WorkoutStrength.create([
      { userId, date: daysAgo(3), routineType: "a" },
      { userId, date: daysAgo(2), routineType: "b" },
      { userId, date: daysAgo(1), routineType: "c" },
    ]);

    // Act
    const sessions = await findRecentStrengthSessions(userId, daysAgo(21), 2);

    // Assert
    expect(sessions).toHaveLength(2);
  });
});

describe("findRecentRunSessions", () => {
  it("never loads the GPS trace", async () => {
    // Arrange: a tracked run holds thousands of points the coach will never quote
    const userId = anUserId();
    await WorkoutRun.create({
      userId,
      date: daysAgo(1),
      distance: 10,
      duration: 3000,
      targetPace: 300,
      gpsPath: [{ lat: 40.4, lng: -3.7 }],
    });

    // Act
    const [run] = await findRecentRunSessions(userId, daysAgo(21), 10);

    // Assert
    expect(run.gpsPath).toBeUndefined();
    expect(run.distance).toBe(10);
  });

  it("excludes another athlete's runs", async () => {
    // Arrange
    await WorkoutRun.create({
      userId: anUserId(),
      date: daysAgo(1),
      distance: 5,
      duration: 1500,
      targetPace: 300,
    });

    // Act
    const runs = await findRecentRunSessions(anUserId(), daysAgo(21), 10);

    // Assert
    expect(runs).toEqual([]);
  });
});
