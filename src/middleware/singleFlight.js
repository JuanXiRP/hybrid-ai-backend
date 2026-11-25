// One in-flight generative request per user.
//
// requireChatQuota / requirePlanQuota count PERSISTED rows before the seconds-long Gemini call, so
// N parallel requests from one athlete all read the same spent quota and all pass. This guard
// closes that window: while a user has a chat (or plan) request running, a second one is refused
// with 429 instead of racing the first.
//
// In-memory on purpose, for the same reason rateLimit.js is: this is one Render instance. A
// module-level Set is exact there. If the service is ever scaled horizontally the guard stops
// being global, and the fix is an atomic reservation in the database (insert-before-call,
// rolled back on failure), not a bigger Set.

const inFlight = new Set();

/**
 * Must be mounted after `protect`, which provides `req.user`.
 *
 * @param {string} name  namespace of the guard; two routes sharing a name share one slot per user
 * @returns {import('express').RequestHandler}
 */
export const singleFlight = (name) => (req, res, next) => {
  const key = `${name}:${req.user._id}`;

  if (inFlight.has(key)) {
    return res.status(429).json({
      success: false,
      code: "REQUEST_IN_PROGRESS",
      message: "Your previous request is still being processed.",
    });
  }

  inFlight.add(key);
  // `finish` covers a normal response, `close` covers a client that hung up first. Either may
  // fire (or both); deleting twice is harmless.
  const release = () => inFlight.delete(key);
  res.once("finish", release);
  res.once("close", release);

  return next();
};

export default singleFlight;
