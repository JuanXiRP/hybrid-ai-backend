import mongoose from "mongoose";
import WorkoutPlan from "../models/WorkoutPlan.js";
import WorkoutRun from "../models/WorkoutRun.js";
import WorkoutStrength from "../models/WorkoutStrength.js";
import {
  buildRoutineContext,
  deriveRoutineContext,
  formatRoutineContext,
} from "../services/routineContextService.js";
import { useTestDatabase } from "@test/helpers/db.js";

useTestDatabase();

const NOW = new Date("2026-03-16T10:00:00.000Z"); // a Monday
const daysBefore = (days) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
const anUserId = () => new mongoose.Types.ObjectId();
const PLAN_ID = new mongoose.Types.ObjectId();

const exercise = (name) => ({ name, sets: "4", reps: "6", rpe: "8" });

const day = (dayName, workoutType = "strength", overrides = {}) => ({
  dayName,
  workoutType,
  source: "generated",
  exercises: workoutType === "rest" ? [] : [exercise("Back Squat")],
  ...overrides,
});

/** An 8-week plan whose current week holds two training days and one rest day. */
const aPlan = (overrides = {}) => ({
  goal: "both",
  durationWeeks: 8,
  startDate: daysBefore(0),
  weeks: Array.from({ length: 8 }, (_, index) => ({
    weekNumber: index + 1,
    days: [
      day("Lower Body"),
      day("Zone 2 Run", "cardio"),
      day("Recovery", "rest"),
    ],
  })),
  ...overrides,
});

/** A twelve-week block, for the phase boundaries. */
const twelveWeeks = () =>
  Array.from({ length: 12 }, (_, index) => ({
    weekNumber: index + 1,
    days: [day("Lower Body")],
  }));

/** A week with three training days and one rest day, for the plan-marker cases. */
const aMarkedPlan = (overrides = {}) => ({
  _id: PLAN_ID,
  goal: "both",
  durationWeeks: 4,
  startDate: daysBefore(0),
  weeks: [
    {
      weekNumber: 1,
      days: [
        day("Lower Body"),
        day("Recovery", "rest"),
        day("Zone 2 Run", "cardio"),
        day("Upper Body"),
      ],
    },
  ],
  ...overrides,
});

const strengthLog = (date, overrides = {}) => ({
  date,
  routineType: "Lower Body",
  exercises: [{ exerciseName: "Back Squat", targetRpe: 7, actualRpe: 9 }],
  ...overrides,
});

const runLog = (date, overrides = {}) => ({
  date,
  distance: 10,
  duration: 3000,
  targetPace: 315,
  actualPace: 300,
  rpe: 7,
  ...overrides,
});

describe("deriveRoutineContext — where the athlete is", () => {
  it("reports no plan when there is none", () => {
    // Arrange / Act
    const context = deriveRoutineContext({ plan: null, now: NOW });

    // Assert
    expect(context.hasPlan).toBe(false);
  });

  it("puts a plan that starts today in week 1", () => {
    // Arrange / Act
    const context = deriveRoutineContext({ plan: aPlan(), now: NOW });

    // Assert
    expect(context.currentWeek).toBe(1);
    expect(context.phase).toBe("base");
  });

  it("rolls over to week 2 on day 8", () => {
    // Arrange
    const plan = aPlan({ startDate: daysBefore(7) });

    // Act
    const context = deriveRoutineContext({ plan, now: NOW });

    // Assert
    expect(context.currentWeek).toBe(2);
  });

  it("clamps a plan dated in the future to week 1 instead of week zero", () => {
    // Arrange: client clock skew, or a block scheduled ahead
    const plan = aPlan({
      startDate: new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000),
    });

    // Act
    const context = deriveRoutineContext({ plan, now: NOW });

    // Assert
    expect(context.currentWeek).toBe(1);
  });

  it("calls a finished macrocycle completed rather than counting past it", () => {
    // Arrange: 8-week plan, started 100 days ago
    const plan = aPlan({ startDate: daysBefore(100) });

    // Act
    const context = deriveRoutineContext({ plan, now: NOW });

    // Assert
    expect(context.phase).toBe("completed");
    expect(context.currentWeek).toBe(8);
  });

  it("names the final week", () => {
    // Arrange
    const plan = aPlan({ startDate: daysBefore(7 * 7) });

    // Act
    const context = deriveRoutineContext({ plan, now: NOW });

    // Assert
    expect(context.currentWeek).toBe(8);
    expect(context.phase).toBe("final week");
  });

  it("labels the middle and late thirds of the macrocycle", () => {
    // Arrange / Act: 12-week block, week 5 is the middle third and week 9 the last
    const build = deriveRoutineContext({
      plan: aPlan({
        startDate: daysBefore(28),
        durationWeeks: 12,
        weeks: twelveWeeks(),
      }),
      now: NOW,
    });
    const peak = deriveRoutineContext({
      plan: aPlan({
        startDate: daysBefore(56),
        durationWeeks: 12,
        weeks: twelveWeeks(),
      }),
      now: NOW,
    });

    // Assert
    expect(build.currentWeek).toBe(5);
    expect(build.phase).toBe("build");
    expect(peak.currentWeek).toBe(9);
    expect(peak.phase).toBe("peak");
  });

  it("reports no week detail when the stored plan has no weeks", () => {
    // Arrange: the import path can produce a plan whose weeks never materialised
    const plan = aPlan({ weeks: [], durationWeeks: 0 });

    // Act
    const context = deriveRoutineContext({ plan, now: NOW });

    // Assert
    expect(context.hasPlan).toBe(true);
    expect(context.currentWeek).toBe(0);
    expect(context.phase).toBe("unknown");
  });

  it("falls back to the array position when weekNumber is missing", () => {
    // Arrange: weekNumber comes from the model and is not validated
    const plan = aPlan({
      startDate: daysBefore(7),
      weeks: [
        { days: [day("Week one session")] },
        { days: [day("Week two session")] },
      ],
      durationWeeks: 2,
    });

    // Act
    const context = deriveRoutineContext({ plan, now: NOW });

    // Assert
    expect(context.nextSession.dayName).toBe("Week two session");
  });
});

describe("deriveRoutineContext — what comes next", () => {
  it("points at the first session with no log behind it", () => {
    // Arrange: one session already logged this week
    const context = deriveRoutineContext({
      plan: aPlan(),
      strengthLogs: [strengthLog(daysBefore(0))],
      now: NOW,
    });

    // Assert
    expect(context.nextSession.dayName).toBe("Zone 2 Run");
    expect(context.sessionsLoggedThisWeek).toBe(1);
  });

  it("returns no next session once the week is fully logged", () => {
    // Arrange: both training days logged
    const context = deriveRoutineContext({
      plan: aPlan(),
      strengthLogs: [strengthLog(daysBefore(0))],
      runLogs: [runLog(daysBefore(0))],
      now: NOW,
    });

    // Assert
    expect(context.nextSession).toBeNull();
    expect(context.remainingSessions).toEqual([]);
  });

  it("counts rest days separately from training days", () => {
    // Arrange / Act
    const context = deriveRoutineContext({ plan: aPlan(), now: NOW });

    // Assert
    expect(context.plannedSessionsThisWeek).toBe(2);
    expect(context.restDaysThisWeek).toBe(1);
  });

  it("ignores sessions logged before the current plan week began", () => {
    // Arrange: a block that started on a Wednesday rolls over on Wednesdays, not Mondays
    const plan = aPlan({ startDate: daysBefore(9) });

    // Act
    const context = deriveRoutineContext({
      plan,
      strengthLogs: [strengthLog(daysBefore(8))], // week 1, not week 2
      now: NOW,
    });

    // Assert
    expect(context.currentWeek).toBe(2);
    expect(context.sessionsLoggedThisWeek).toBe(0);
  });
});

describe("deriveRoutineContext — plan markers on a logged session", () => {
  it("closes exactly the day a marked session names, not the next one in order", () => {
    // Arrange: the athlete did the RUN first (day index 2), skipping the squat day
    const context = deriveRoutineContext({
      plan: aMarkedPlan(),
      runLogs: [
        runLog(daysBefore(0), { weekNumber: 1, dayIndex: 2, planId: PLAN_ID }),
      ],
      now: NOW,
    });

    // Assert: the counting inference would have closed "Lower Body" here and been wrong
    expect(context.nextSession.dayName).toBe("Lower Body");
    expect(context.remainingSessions).toEqual(["Lower Body", "Upper Body"]);
    expect(context.sessionsLoggedThisWeek).toBe(1);
    expect(context.nextSessionIsExact).toBe(true);
  });

  it("attributes a marked session by its markers, whatever day it was written on", () => {
    // Arrange: Monday's session logged two days late
    const context = deriveRoutineContext({
      plan: aMarkedPlan({ startDate: daysBefore(3) }),
      strengthLogs: [
        strengthLog(daysBefore(0), {
          weekNumber: 1,
          dayIndex: 0,
          planId: PLAN_ID,
        }),
      ],
      now: NOW,
    });

    // Assert
    expect(context.remainingSessions).toEqual(["Zone 2 Run", "Upper Body"]);
  });

  it("ignores markers that belong to a different plan", () => {
    // Arrange: a session logged against the block the athlete finished last month
    const context = deriveRoutineContext({
      plan: aMarkedPlan(),
      strengthLogs: [
        strengthLog(daysBefore(30), {
          weekNumber: 1,
          dayIndex: 0,
          planId: new mongoose.Types.ObjectId(),
        }),
      ],
      now: NOW,
    });

    // Assert: neither its markers nor its date may close a day of the current plan
    expect(context.sessionsLoggedThisWeek).toBe(0);
    expect(context.nextSession.dayName).toBe("Lower Body");
  });

  it("ignores markers for a week the athlete is no longer in", () => {
    // Arrange: last week's sessions, fully marked, against a two-week block
    const context = deriveRoutineContext({
      plan: aMarkedPlan({
        startDate: daysBefore(7),
        weeks: [
          { weekNumber: 1, days: [day("Lower Body")] },
          {
            weekNumber: 2,
            days: [
              day("Lower Body"),
              day("Recovery", "rest"),
              day("Zone 2 Run", "cardio"),
              day("Upper Body"),
            ],
          },
        ],
      }),
      strengthLogs: [
        strengthLog(daysBefore(6), {
          weekNumber: 1,
          dayIndex: 0,
          planId: PLAN_ID,
        }),
      ],
      now: NOW,
    });

    // Assert: week 2 starts clean
    expect(context.currentWeek).toBe(2);
    expect(context.sessionsLoggedThisWeek).toBe(0);
  });

  it("falls back to counting when a session carries no markers", () => {
    // Arrange: a client that predates the fields
    const context = deriveRoutineContext({
      plan: aMarkedPlan(),
      strengthLogs: [strengthLog(daysBefore(0))],
      now: NOW,
    });

    // Assert: the first training day is assumed done, and the claim is marked inexact
    expect(context.nextSession.dayName).toBe("Zone 2 Run");
    expect(context.nextSessionIsExact).toBe(false);
  });

  it("mixes a marked and an unmarked session without double-counting either", () => {
    // Arrange: the run is marked; the other session is anonymous
    const context = deriveRoutineContext({
      plan: aMarkedPlan(),
      runLogs: [
        runLog(daysBefore(0), { weekNumber: 1, dayIndex: 2, planId: PLAN_ID }),
      ],
      strengthLogs: [strengthLog(daysBefore(0))],
      now: NOW,
    });

    // Assert: the run closed its own day, the anonymous one consumes the earliest day left
    expect(context.sessionsLoggedThisWeek).toBe(2);
    expect(context.remainingSessions).toEqual(["Upper Body"]);
    expect(context.nextSessionIsExact).toBe(false);
  });

  it("reports the week finished when every training day is marked", () => {
    // Arrange
    const context = deriveRoutineContext({
      plan: aMarkedPlan(),
      strengthLogs: [
        strengthLog(daysBefore(2), {
          weekNumber: 1,
          dayIndex: 0,
          planId: PLAN_ID,
        }),
        strengthLog(daysBefore(0), {
          weekNumber: 1,
          dayIndex: 3,
          planId: PLAN_ID,
        }),
      ],
      runLogs: [
        runLog(daysBefore(1), { weekNumber: 1, dayIndex: 2, planId: PLAN_ID }),
      ],
      now: NOW,
    });

    // Assert
    expect(context.nextSession).toBeNull();
    expect(context.sessionsLoggedThisWeek).toBe(3);
  });

  it("does not let a marked rest day close a training day", () => {
    // Arrange: dayIndex 1 is the rest day
    const context = deriveRoutineContext({
      plan: aMarkedPlan(),
      strengthLogs: [
        strengthLog(daysBefore(0), {
          weekNumber: 1,
          dayIndex: 1,
          planId: PLAN_ID,
        }),
      ],
      now: NOW,
    });

    // Assert: all three training days are still open
    expect(context.sessionsLoggedThisWeek).toBe(0);
    expect(context.remainingSessions).toHaveLength(3);
  });
});

describe("formatRoutineContext", () => {
  it("returns nothing at all when the athlete has no plan", () => {
    // Arrange / Act / Assert
    expect(
      formatRoutineContext(deriveRoutineContext({ plan: null, now: NOW })),
    ).toBe("");
  });

  it("states the week, the phase and the next session with its exercises", () => {
    // Arrange
    const context = deriveRoutineContext({ plan: aPlan(), now: NOW });

    // Act
    const block = formatRoutineContext(context);

    // Assert
    expect(block).toContain("week 1 of 8");
    expect(block).toContain("Lower Body");
    expect(block).toContain("Back Squat 4x6 @RPE 8");
  });

  it("never claims to know what the athlete trains today", () => {
    // Arrange: no calendar mapping exists, so the label must stay honest
    const block = formatRoutineContext(
      deriveRoutineContext({ plan: aPlan(), now: NOW }),
    );

    // Assert
    expect(block).toContain("inferred from logged sessions, not confirmed");
    expect(block).not.toMatch(/today you/i);
  });

  it("stops hedging once the logs name the days they closed", () => {
    // Arrange
    const context = deriveRoutineContext({
      plan: aMarkedPlan(),
      runLogs: [
        runLog(daysBefore(0), { weekNumber: 1, dayIndex: 2, planId: PLAN_ID }),
      ],
      now: NOW,
    });

    // Act
    const block = formatRoutineContext(context);

    // Assert
    expect(block).toContain("NEXT SESSION (not yet logged this week)");
    expect(block).not.toContain("inferred");
  });

  it("marks an imported session as the athlete's own program", () => {
    // Arrange
    const plan = aPlan({
      weeks: [
        {
          weekNumber: 1,
          days: [day("Club Session", "strength", { source: "imported" })],
        },
      ],
      durationWeeks: 1,
    });

    // Act
    const block = formatRoutineContext(
      deriveRoutineContext({ plan, now: NOW }),
    );

    // Assert
    expect(block).toContain("do not rewrite it");
  });

  it("admits when the stored plan has no week-by-week detail", () => {
    // Arrange: an import that produced no weeks
    const plan = aPlan({ weeks: [], durationWeeks: 0 });

    // Act
    const block = formatRoutineContext(
      deriveRoutineContext({ plan, now: NOW }),
    );

    // Assert
    expect(block).toContain("records no weeks");
    expect(block).not.toMatch(/week \d+ of/);
  });

  it("tells the coach when the macrocycle is over", () => {
    // Arrange
    const plan = aPlan({ startDate: daysBefore(100) });

    // Act
    const block = formatRoutineContext(
      deriveRoutineContext({ plan, now: NOW }),
    );

    // Assert
    expect(block).toContain("They need a new plan.");
  });

  it("says so when every planned session is already logged", () => {
    // Arrange
    const context = deriveRoutineContext({
      plan: aPlan(),
      strengthLogs: [strengthLog(daysBefore(0))],
      runLogs: [runLog(daysBefore(0))],
      now: NOW,
    });

    // Act / Assert
    expect(formatRoutineContext(context)).toContain("already logged");
  });

  it("reports RPE against target for a logged strength session", () => {
    // Arrange: actual 9 against target 7
    const context = deriveRoutineContext({
      plan: aPlan(),
      strengthLogs: [strengthLog(daysBefore(1))],
      now: NOW,
    });

    // Act
    const block = formatRoutineContext(context);

    // Assert
    expect(block).toContain("RPE 9.0 vs target 7.0 (harder than planned)");
  });

  it("omits run metrics the client never filled in", () => {
    // Arrange: an older client build syncs a run with only its RPE filled in
    const context = deriveRoutineContext({
      plan: aPlan(),
      runLogs: [
        runLog(daysBefore(1), {
          distance: 0,
          duration: 0,
          targetPace: 0,
          actualPace: 0,
        }),
      ],
      now: NOW,
    });

    // Act
    const block = formatRoutineContext(context);

    // Assert
    expect(block).toContain("run, RPE 7");
    expect(block).not.toContain("0 km");
    expect(block).not.toContain("0:00");
  });

  it("drops a whole low-priority section rather than cutting one in half", () => {
    // Arrange: a budget that fits the plan line and nothing after it
    const context = deriveRoutineContext({
      plan: aPlan(),
      strengthLogs: [strengthLog(daysBefore(1))],
      now: NOW,
    });

    // Act
    const block = formatRoutineContext(context, { maxChars: 70 });

    // Assert
    expect(block).toContain("week 1 of 8");
    expect(block).not.toContain("NEXT SESSION");
    expect(block.endsWith(".")).toBe(true);
  });
});

describe("buildRoutineContext", () => {
  it("returns an empty block for an athlete with no plan", async () => {
    // Arrange / Act
    const block = await buildRoutineContext(anUserId(), NOW);

    // Assert
    expect(block).toBe("");
  });

  it("hydrates from the stored plan and the athlete's logs", async () => {
    // Arrange
    const userId = anUserId();
    await WorkoutPlan.create({ userId, ...aPlan() });
    await WorkoutStrength.create({
      userId,
      date: daysBefore(0),
      routineType: "Lower Body",
      exercises: [
        {
          exerciseName: "Back Squat",
          sets: 4,
          reps: 6,
          targetWeight: 100,
          actualWeight: 100,
          targetRpe: 7,
          actualRpe: 9,
        },
      ],
    });
    await WorkoutRun.create({
      userId,
      date: daysBefore(30), // outside the lookback window
      distance: 21,
      duration: 6000,
      targetPace: 300,
    });

    // Act
    const block = await buildRoutineContext(userId, NOW);

    // Assert
    expect(block).toContain("week 1 of 8");
    expect(block).toContain("Zone 2 Run"); // the next session, the squat day being logged
    expect(block).toContain("1 of 2 sessions logged");
    expect(block).not.toContain("21 km"); // the stale run is outside the window
  });
});
