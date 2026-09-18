// Read side of the plan lifecycle. Both routes were previously only touched incidentally by
// entitlement.test.js, which asserted the status code and nothing else — so the 404 branch and
// the history payload were untested.

import WorkoutPlan from "../models/WorkoutPlan.js";
import {
  makeGetActivePlanRequest,
  makeGetPlanHistoryRequest,
} from "@test/helpers/api.js";
import { registerTestUser } from "@test/helpers/auth.js";
import { silenceConsole } from "@test/helpers/console.js";
import { useTestDatabase } from "@test/helpers/db.js";

useTestDatabase();

// The two failure tests drive catch blocks that log before responding.
silenceConsole();

const seedPlan = (userId, overrides = {}) =>
  WorkoutPlan.create({
    userId,
    durationWeeks: 8,
    goal: "strength",
    weeks: [
      {
        weekNumber: 1,
        days: [{ dayName: "Lower", workoutType: "strength", exercises: [] }],
      },
    ],
    ...overrides,
  });

afterEach(() => {
  jest.restoreAllMocks();
});

describe("GET /api/plans/active", () => {
  it("requires authentication", async () => {
    // Act
    const res = await makeGetActivePlanRequest(null);

    // Assert
    expect(res.status).toBe(401);
  });

  it("returns 404 when the user has no plan at all", async () => {
    // Arrange
    const { token } = await registerTestUser();

    // Act
    const res = await makeGetActivePlanRequest(token);

    // Assert
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/No active workout plan/);
  });

  it("returns the plan with its nested weeks", async () => {
    // Arrange
    const { token, id } = await registerTestUser();
    await seedPlan(id);

    // Act
    const res = await makeGetActivePlanRequest(token);

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.data.goal).toBe("strength");
    expect(res.body.data.weeks).toHaveLength(1);
  });

  // Regenerating deactivates the previous plan; the lookup filters on active: true, so an
  // inactive plan must read as "no plan" rather than being served as the current one.
  it("ignores an inactive plan", async () => {
    // Arrange
    const { token, id } = await registerTestUser();
    await seedPlan(id, { active: false });

    // Act
    const res = await makeGetActivePlanRequest(token);

    // Assert
    expect(res.status).toBe(404);
  });

  it("never serves another user's plan", async () => {
    // Arrange
    const owner = await registerTestUser();
    const stranger = await registerTestUser();
    await seedPlan(owner.id);

    // Act
    const res = await makeGetActivePlanRequest(stranger.token);

    // Assert
    expect(res.status).toBe(404);
  });

  it("answers 500 rather than crashing when the query fails", async () => {
    // Arrange
    const { token } = await registerTestUser();
    jest.spyOn(WorkoutPlan, "findOne").mockReturnValue({
      sort: () => Promise.reject(new Error("mongo is down")),
    });

    // Act
    const res = await makeGetActivePlanRequest(token);

    // Assert
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Server Error");
  });
});

describe("GET /api/plans/history", () => {
  it("requires authentication", async () => {
    // Act
    const res = await makeGetPlanHistoryRequest(null);

    // Assert
    expect(res.status).toBe(401);
  });

  it("returns an empty list with a zero count for a new user", async () => {
    // Arrange
    const { token } = await registerTestUser();

    // Act
    const res = await makeGetPlanHistoryRequest(token);

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.data).toEqual([]);
  });

  // The weeks array is the bulk of the document; shipping it in a list view would send megabytes
  // the client discards. The projection is the whole point of this endpoint existing separately.
  it("lists plans newest first and omits the heavy weeks array", async () => {
    // Arrange
    const { token, id } = await registerTestUser();
    const older = await seedPlan(id, { goal: "strength" });
    const newer = await seedPlan(id, { goal: "endurance" });
    // createdAt is set on insert and the two writes can land in the same millisecond, so make
    // the ordering unambiguous instead of relying on wall-clock luck.
    await WorkoutPlan.updateOne(
      { _id: older._id },
      { $set: { createdAt: new Date(Date.now() - 60_000) } },
    );

    // Act
    const res = await makeGetPlanHistoryRequest(token);

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.data.map((p) => p._id)).toEqual([
      String(newer._id),
      String(older._id),
    ]);
    expect(res.body.data[0].weeks).toBeUndefined();
  });

  it("never lists another user's plans", async () => {
    // Arrange
    const owner = await registerTestUser();
    const stranger = await registerTestUser();
    await seedPlan(owner.id);

    // Act
    const res = await makeGetPlanHistoryRequest(stranger.token);

    // Assert
    expect(res.body.count).toBe(0);
  });

  it("answers 500 rather than crashing when the query fails", async () => {
    // Arrange
    const { token } = await registerTestUser();
    jest.spyOn(WorkoutPlan, "find").mockReturnValue({
      sort: () => ({
        select: () => Promise.reject(new Error("mongo is down")),
      }),
    });

    // Act
    const res = await makeGetPlanHistoryRequest(token);

    // Assert
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Server Error");
  });
});
