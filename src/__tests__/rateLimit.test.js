// The per-IP limiter, driven through a real Express app rather than asserted as configuration.
//
// Configuration assertions would pass against a limiter that never runs, which is precisely the
// failure mode worth guarding here: the middleware deliberately skips itself under NODE_ENV=test,
// so the only way to know it works is to take that skip away for the length of a test.

import express from "express";
import supertest from "supertest";
import { createRateLimiter, skipRateLimit } from "../middleware/rateLimit.js";

/** A throwaway app whose only route is protected by `limiter`. */
const appWith = (limiter) => {
  const app = express();
  app.use(limiter);
  app.get("/ping", (req, res) => res.status(200).json({ success: true }));
  return app;
};

describe("skipRateLimit", () => {
  it("is on under the test environment, and off everywhere else", () => {
    // Arrange
    const original = process.env.NODE_ENV;

    // Act & Assert
    process.env.NODE_ENV = "test";
    expect(skipRateLimit()).toBe(true);

    process.env.NODE_ENV = "production";
    expect(skipRateLimit()).toBe(false);

    process.env.NODE_ENV = original;
  });

  it("lets the suite fire as many requests as it likes", async () => {
    // Arrange: supertest makes every request look like one client, so a counted suite would fail
    // itself long before it ever failed an attacker.
    const app = appWith(createRateLimiter({ limit: 1, message: "nope" }));

    // Act
    const statuses = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      statuses.push((await supertest(app).get("/ping")).status);
    }

    // Assert
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
  });
});

describe("createRateLimiter, with the test skip taken away", () => {
  const original = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it("serves requests up to the limit and refuses the one after it", async () => {
    // Arrange
    const app = appWith(
      createRateLimiter({ limit: 2, message: "Too many requests." }),
    );

    // Act
    const first = await supertest(app).get("/ping");
    const second = await supertest(app).get("/ping");
    const third = await supertest(app).get("/ping");

    // Assert
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(third.status).toBe(429);
  });

  it("refuses in the same envelope every other failure uses", async () => {
    // Arrange: a 429 that broke the shape would need a special case in the Android client
    const app = appWith(
      createRateLimiter({ limit: 1, message: "Please slow down." }),
    );

    // Act
    await supertest(app).get("/ping");
    const blocked = await supertest(app).get("/ping");

    // Assert
    expect(blocked.body).toEqual({
      success: false,
      message: "Please slow down.",
    });
  });

  it("advertises the budget so a client can back off before being cut off", async () => {
    // Arrange
    const app = appWith(createRateLimiter({ limit: 5, message: "nope" }));

    // Act
    const res = await supertest(app).get("/ping");

    // Assert: the standard RateLimit-* headers, and none of the legacy X-RateLimit-* ones
    expect(res.headers).toEqual(
      expect.objectContaining({ "ratelimit-limit": expect.any(String) }),
    );
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
  });

  it("counts each window separately", async () => {
    // Arrange: a window short enough to outlive inside a test
    const app = appWith(
      createRateLimiter({ windowMs: 150, limit: 1, message: "nope" }),
    );

    // Act
    const first = await supertest(app).get("/ping");
    const blocked = await supertest(app).get("/ping");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterWindow = await supertest(app).get("/ping");

    // Assert
    expect([first.status, blocked.status, afterWindow.status]).toEqual([
      200, 429, 200,
    ]);
  });
});
