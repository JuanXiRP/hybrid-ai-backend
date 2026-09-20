// Per-IP rate limiting.
//
// Why it exists: every route in this app authenticates a caller or reaches the database, and
// three of them spend money with Google on each call. Without a limiter, one client can
// brute-force a password, exhaust the Atlas connection pool, or run up the Gemini bill unchecked.
// CodeQL's js/missing-rate-limiting flagged exactly this, and it was right — nothing here was
// limited at all.
//
// This is NOT the freemium quota, and the two must not be confused. `entitlementMiddleware` is
// per-USER, derived from persisted data, and answers "has this athlete paid for this?" — a
// premium user passes it without limit. This one is per-IP, in-memory, and answers "is this
// traffic abusive?", which a premium user can be just as easily as anyone else.
//
// The store is in-memory on purpose: this is one Render instance, and a limiter that needs Redis
// to function is a limiter that silently stops protecting anything the day Redis blinks. If the
// deployment is ever scaled horizontally, each instance enforcing its own share is a known
// approximation — the ceiling becomes `limit × instances`, which is still a ceiling.

import rateLimit from "express-rate-limit";

const MINUTE_MS = 60 * 1000;
const WINDOW_MS = 15 * MINUTE_MS;

/**
 * The Jest suite fires hundreds of requests and supertest makes all of them look like one client,
 * so a counted test run would fail the suite instead of an attacker.
 *
 * Read at request time rather than at module load, which is what lets `rateLimit.test.js` drive
 * the real middleware by flipping NODE_ENV instead of asserting on configuration.
 *
 * @returns {boolean}
 */
export const skipRateLimit = () => process.env.NODE_ENV === "test";

/**
 * @param {{windowMs?: number, limit: number, message: string}} options
 * @returns {import('express').RequestHandler}
 */
export const createRateLimiter = ({ windowMs = WINDOW_MS, limit, message }) =>
  rateLimit({
    windowMs,
    limit,
    skip: skipRateLimit,
    // RateLimit-* headers so a well-behaved client can back off before being cut off.
    standardHeaders: true,
    legacyHeaders: false,
    // The same envelope every other failure in this API uses, so no client needs a special case
    // for 429 — the Android side already reads `message` off any non-2xx body.
    message: { success: false, message },
  });

/**
 * The app-wide backstop. Deliberately generous: it is not the real gate for anything, it is the
 * ceiling that stops a single address from monopolising the process.
 */
export const globalLimiter = createRateLimiter({
  limit: 300,
  message: "Too many requests. Please slow down and try again shortly.",
});

/**
 * Credentials. The tightest of the three, because these are the only endpoints where guessing
 * repeatedly is the whole attack.
 */
export const authLimiter = createRateLimiter({
  limit: 20,
  message:
    "Too many sign-in attempts. Please wait a few minutes and try again.",
});

/**
 * The AI surface: coach chat, and reading the transcript back.
 *
 * Sized for a real conversation — a person typing steadily sends a handful of messages a minute,
 * and each one waits seconds on Gemini — while still cutting off a script.
 */
export const aiLimiter = createRateLimiter({
  limit: 60,
  message: "Too many coach requests. Please wait a few minutes and try again.",
});

/**
 * Plan generation and import: the most expensive calls in the product, by a wide margin. A free
 * athlete gets one plan ever, so anything above this is either a retry storm or abuse.
 */
export const generativeLimiter = createRateLimiter({
  limit: 10,
  message: "Too many plan requests. Please wait a few minutes and try again.",
});
