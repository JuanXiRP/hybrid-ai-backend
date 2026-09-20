// The sliding window: how much of a conversation the coach is allowed to remember.
//
// Pure by design — no database, no Gemini, no clock. Everything here is a decision about a list
// of turns, which is what makes the ordering rules below testable in isolation; they were
// previously inlined in the controller as `sanitizeHistory` and exercised only through HTTP.
//
// Two separate budgets bound the prompt: a turn cap (how many exchanges are relevant) and a
// character budget (what they cost). The turn cap alone is not enough — twenty turns of pasted
// training logs is a far bigger prompt than twenty one-line questions.

// Read lazily so a test can override a limit per case without re-importing the module, the same
// pattern the freemium limits use in entitlementService.
export const windowMaxTurns = () =>
  Number(process.env.CHAT_WINDOW_MAX_TURNS ?? 20);
export const windowMaxChars = () =>
  Number(process.env.CHAT_WINDOW_MAX_CHARS ?? 8000);

/**
 * Keep only well-formed turns, stripped to the two fields the model consumes.
 *
 * Applied to rows this service itself wrote, so it is defensive rather than load-bearing: a
 * legacy migrated turn, or a row written before the schema enforced an enum, must not be able to
 * reach the prompt as `{ role: 'system' }` or as an empty string.
 *
 * @param {unknown} turns
 * @returns {Array<{role: 'user'|'model', content: string}>}
 */
export const normalizeTurns = (turns) =>
  (Array.isArray(turns) ? turns : [])
    .filter(
      (turn) =>
        turn &&
        (turn.role === "user" || turn.role === "model") &&
        typeof turn.content === "string" &&
        turn.content.trim() !== "",
    )
    .map((turn) => ({ role: turn.role, content: turn.content }));

/**
 * Enforce Gemini's two rules for a prior-history array: it must start with a 'user' turn, and it
 * must not end with one — `sendMessage` appends the current message as the final user turn, and
 * two consecutive user turns are rejected by the API.
 *
 * @param {Array<{role: 'user'|'model', content: string}>} turns
 * @returns {Array<{role: 'user'|'model', content: string}>}
 */
export const trimForGemini = (turns) => {
  const trimmed = [...turns];
  while (trimmed.length && trimmed[0].role === "model") trimmed.shift();
  while (trimmed.length && trimmed[trimmed.length - 1].role === "user")
    trimmed.pop();
  return trimmed;
};

/**
 * Build the history the model will see: turn cap, then character budget (oldest dropped first),
 * then the Gemini validity trim.
 *
 * **The order is load-bearing.** Dropping the oldest turns to fit the budget can itself leave a
 * 'model' turn at the head of the window, so the validity trim has to run last or the request is
 * rejected by the API. A turn that is on its own larger than the whole budget is dropped rather
 * than truncated: half a message is worse context than no message.
 *
 * The budget covers history only. The hydrated system block and the new user message have their
 * own budgets, so a long routine can never eat the conversation's memory.
 *
 * @param {unknown} turns oldest-first
 * @param {{maxTurns?: number, maxChars?: number}} [limits]
 * @returns {Array<{role: 'user'|'model', content: string}>} oldest-first, safe to send
 */
export const buildWindow = (
  turns,
  { maxTurns = windowMaxTurns(), maxChars = windowMaxChars() } = {},
) => {
  const recent = normalizeTurns(turns).slice(-maxTurns);

  let used = 0;
  let start = recent.length;
  for (let index = recent.length - 1; index >= 0; index--) {
    const cost = recent[index].content.length;
    if (used + cost > maxChars) break;
    used += cost;
    start = index;
  }

  return trimForGemini(recent.slice(start));
};
