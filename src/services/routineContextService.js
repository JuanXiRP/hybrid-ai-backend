// Turns the athlete's stored training data into the compact block the coach prompt carries.
//
// BOUNDARY: this module renders DATA, never persona or instructions. The coaching voice, the
// framing sentence and everything else that shapes how the model behaves stays in
// geminiService.js, which is the only place allowed to hold prompt logic. What comes out of here
// is the same kind of artefact the client used to send as `plan_context` — a description of the
// athlete, not a description of the assistant.
//
// HONESTY RULE: this module may only report what the data supports, and must label how strong
// each claim is. Nothing in the schema records which week the athlete is on, no plan day carries
// a completion flag, and `dayName` is a session label ("Lower Body"), not a weekday — so the
// current week is always derived from the plan's start date, and the block never states "today
// you train X". That sentence cannot be supported by this data, and a coach that invents it is
// worse than one that asks.
//
// Which sessions are DONE has two accuracies, and they are distinguished deliberately. A logged
// session that carries `weekNumber`/`dayIndex` names the plan day it closed, so what is left in
// the week is a fact. One that does not — every session written by a client older than those
// fields — can only be counted, so the next session is a guess about ordering and is labelled as
// one. Never collapse the two.

import {
  findActivePlan,
  findRecentRunSessions,
  findRecentStrengthSessions,
} from "../repositories/trainingRepository.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// Three weeks covers the current plan week plus enough history for the feedback lines.
const LOG_LOOKBACK_MS = 21 * DAY_MS;
const LOG_FETCH_LIMIT = 20;
const RECENT_FEEDBACK_LINES = 3;

// Read lazily so a test can override it per case, the same pattern entitlementService uses.
const routineMaxChars = () =>
  Number(process.env.CHAT_ROUTINE_CONTEXT_MAX_CHARS ?? 2000);

const startOfUtcDay = (date) =>
  new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );

const isoDay = (date) => new Date(date).toISOString().slice(0, 10);

/** mm:ss from a duration in seconds. */
const asClock = (seconds) => {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

const average = (values) =>
  values.reduce((total, value) => total + value, 0) / values.length;

/**
 * Where the macrocycle currently is, as a label the model can reason about.
 *
 * Thirds rather than named mesocycles: the plan schema records no phase, so anything finer would
 * be invented. `final week` is called out separately because it is the one boundary at which a
 * coach should behave differently.
 */
const derivePhase = (currentWeek, totalWeeks) => {
  if (currentWeek >= totalWeeks) return "final week";
  const progress = currentWeek / totalWeeks;
  if (progress <= 1 / 3) return "base";
  if (progress <= 2 / 3) return "build";
  return "peak";
};

/** A logged run carries no exercises; a logged strength session always has routineType. */
const isRunSession = (session) => session.routineType === undefined;

const describeStrengthSession = (session) => {
  const exercises = session.exercises ?? [];
  const actual = exercises
    .map((exercise) => exercise.actualRpe)
    .filter((rpe) => typeof rpe === "number");
  const target = exercises
    .map((exercise) => exercise.targetRpe)
    .filter((rpe) => typeof rpe === "number");

  const parts = [`${session.routineType ?? "strength"} session`];
  if (exercises.length > 0) parts.push(`${exercises.length} exercises`);

  if (actual.length > 0 && target.length > 0) {
    const actualMean = average(actual);
    const targetMean = average(target);
    const verdict =
      actualMean > targetMean + 0.5
        ? " (harder than planned)"
        : actualMean < targetMean - 0.5
          ? " (easier than planned)"
          : "";
    parts.push(
      `RPE ${actualMean.toFixed(1)} vs target ${targetMean.toFixed(1)}${verdict}`,
    );
  }

  return parts.join(", ");
};

const describeRunSession = (session) => {
  // Every metric is conditional because a run can arrive with all of them zeroed — older client
  // builds sync a completed run with only its RPE filled in. A line reading "0 km in 0:00" is a
  // fact the model would repeat back to the athlete.
  const parts = ["run"];
  if (session.distance > 0) parts.push(`${session.distance} km`);
  if (session.duration > 0) parts.push(`in ${asClock(session.duration)}`);
  if (session.actualPace > 0) {
    const target =
      session.targetPace > 0
        ? ` vs target ${asClock(session.targetPace)}/km`
        : "";
    parts.push(`pace ${asClock(session.actualPace)}/km${target}`);
  }
  if (typeof session.rpe === "number") parts.push(`RPE ${session.rpe}`);
  return parts.join(", ");
};

const describeSession = (session) =>
  `${isoDay(session.date)} ${
    isRunSession(session)
      ? describeRunSession(session)
      : describeStrengthSession(session)
  }`;

/**
 * Work out where the athlete stands, from the plan and what they have actually logged.
 *
 * Pure: no database, and no clock of its own — `now` is injected so every edge below is testable.
 *
 * @param {{plan: object|null, strengthLogs?: object[], runLogs?: object[], now: Date}} input
 * @returns {{
 *   hasPlan: boolean, goal?: string, startedAt?: Date,
 *   currentWeek: number, totalWeeks: number, phase: string,
 *   nextSession: object|null, nextSessionIsExact: boolean, remainingSessions: string[],
 *   sessionsLoggedThisWeek: number, plannedSessionsThisWeek: number, restDaysThisWeek: number,
 *   recentFeedback: string[],
 * }}
 */
export const deriveRoutineContext = ({
  plan,
  strengthLogs = [],
  runLogs = [],
  now,
}) => {
  const empty = {
    hasPlan: false,
    currentWeek: 0,
    totalWeeks: 0,
    phase: "none",
    nextSession: null,
    nextSessionIsExact: false,
    remainingSessions: [],
    sessionsLoggedThisWeek: 0,
    plannedSessionsThisWeek: 0,
    restDaysThisWeek: 0,
    recentFeedback: [],
  };

  if (!plan) return empty;

  // The weeks array is authoritative: the model occasionally returns fewer weeks than were
  // requested, and durationWeeks records what was asked for rather than what exists.
  const totalWeeks = plan.weeks?.length || plan.durationWeeks || 0;

  // startDate is defaulted to creation time on every document and no endpoint writes it yet, so
  // today it equals createdAt. It is still the right anchor: the day a block starts on is a
  // property of the plan, not of when the row happened to be inserted.
  const anchor = plan.startDate ?? plan.createdAt ?? now;
  const elapsedDays =
    (startOfUtcDay(now) - startOfUtcDay(new Date(anchor))) / DAY_MS;
  const rawWeek = Math.floor(elapsedDays / 7) + 1;

  const base = {
    hasPlan: true,
    goal: plan.goal,
    startedAt: new Date(anchor),
    totalWeeks,
  };

  // A plan whose weeks never materialised (the import path can produce one). Report the goal and
  // nothing else — a week number here would be fiction.
  if (totalWeeks === 0) {
    return { ...empty, ...base, currentWeek: 0, phase: "unknown" };
  }

  // The macrocycle is over. Say so, rather than counting into week 14 of a 12-week block.
  if (rawWeek > totalWeeks) {
    return { ...empty, ...base, currentWeek: totalWeeks, phase: "completed" };
  }

  // A future anchor (a plan dated ahead, or client clock skew) means the block has not started.
  const currentWeek = Math.max(1, rawWeek);

  // weekNumber comes from the model and is neither validated nor guaranteed unique, so the
  // positional lookup is the safety net.
  const week =
    plan.weeks?.find((entry) => entry.weekNumber === currentWeek) ??
    plan.weeks?.[currentWeek - 1] ??
    null;

  const days = week?.days ?? [];
  // Carry the array position: it is what a logged session's `dayIndex` refers to, so it has to
  // survive the rest-day filter.
  const trainingDays = days
    .map((day, index) => ({ ...day, index }))
    .filter((day) => day.workoutType !== "rest");

  // Counted from the plan's own week boundary, not the calendar's: a block that started on a
  // Wednesday rolls over on Wednesdays.
  const weekStart = new Date(
    startOfUtcDay(new Date(anchor)).getTime() + (currentWeek - 1) * WEEK_MS,
  );
  const sessions = [...strengthLogs, ...runLogs];

  // Two kinds of log can exist side by side, and they are attributed differently.
  //
  // A MARKED session names the plan day it completed, so it is attributed by its markers and its
  // date is irrelevant — logging Monday's session on Wednesday still closes Monday. A marker from
  // another plan is ignored outright, or finishing a block and starting a new one would carry the
  // old plan's progress into the new one.
  const marked = sessions.filter(
    (session) =>
      Number.isInteger(session.weekNumber) &&
      Number.isInteger(session.dayIndex) &&
      (!session.planId || String(session.planId) === String(plan._id)),
  );
  const loggedDayIndexes = new Set(
    marked
      .filter((session) => session.weekNumber === currentWeek)
      .map((session) => session.dayIndex),
  );

  // An UNMARKED session (any client older than these fields) can only be placed by its date, and
  // says nothing about WHICH day it was.
  const unmarkedThisWeek = sessions.filter(
    (session) =>
      !marked.includes(session) && new Date(session.date) >= weekStart,
  ).length;

  // Days still open: the ones no marked log closed, minus however many anonymous sessions were
  // logged this week — those are assumed, as before, to have been worked through in plan order.
  const unloggedDays = trainingDays.filter(
    (day) => !loggedDayIndexes.has(day.index),
  );
  const remainingDays = unloggedDays.slice(
    Math.min(unmarkedThisWeek, unloggedDays.length),
  );

  return {
    ...base,
    currentWeek,
    phase: derivePhase(currentWeek, totalWeeks),
    nextSession: remainingDays[0] ?? null,
    // True when every session this week named the day it completed, so "what is left" is a fact
    // rather than an inference and the prompt may say so.
    nextSessionIsExact: unmarkedThisWeek === 0 && loggedDayIndexes.size > 0,
    remainingSessions: remainingDays.map((day) => day.dayName).filter(Boolean),
    sessionsLoggedThisWeek: trainingDays.length - remainingDays.length,
    plannedSessionsThisWeek: trainingDays.length,
    restDaysThisWeek: days.length - trainingDays.length,
    recentFeedback: sessions
      .slice()
      .sort((left, right) => new Date(right.date) - new Date(left.date))
      .slice(0, RECENT_FEEDBACK_LINES)
      .map(describeSession),
  };
};

const describeExercises = (day) =>
  (day.exercises ?? [])
    .map(
      (exercise) =>
        `${exercise.name} ${exercise.sets}x${exercise.reps} @RPE ${exercise.rpe}`,
    )
    .join("; ");

/**
 * Render the derived state as text, within a character budget.
 *
 * Sections are appended whole, in priority order, and the first one that does not fit ends the
 * block. Dropping a whole section keeps the remaining text coherent; cutting mid-line hands the
 * model a half-written exercise that it will happily quote back.
 *
 * @param {ReturnType<typeof deriveRoutineContext>} context
 * @param {{maxChars?: number}} [options]
 * @returns {string} empty when there is nothing defensible to say
 */
export const formatRoutineContext = (
  context,
  { maxChars = routineMaxChars() } = {},
) => {
  if (!context.hasPlan) return "";

  const sections = [];

  if (context.phase === "completed") {
    sections.push(
      `PLAN: ${context.goal} — all ${context.totalWeeks} weeks of this macrocycle are behind the athlete (started ${isoDay(context.startedAt)}). They need a new plan.`,
    );
  } else if (context.currentWeek === 0) {
    sections.push(
      `PLAN: ${context.goal} — the stored plan records no weeks, so its week-by-week detail is unavailable.`,
    );
  } else {
    sections.push(
      `PLAN: ${context.goal} — week ${context.currentWeek} of ${context.totalWeeks} (${context.phase}), started ${isoDay(context.startedAt)}.`,
    );
  }

  if (context.nextSession) {
    const day = context.nextSession;
    const provenance =
      day.source === "imported"
        ? " (from the athlete's own program — do not rewrite it)"
        : "";
    const exercises = describeExercises(day);
    // Two different claims, and the difference is the whole point of the plan markers on a
    // logged session: when every session this week named the day it closed, the sessions left
    // are a fact. When they did not, the order is an assumption and the prompt must say so.
    const qualifier = context.nextSessionIsExact
      ? "not yet logged this week"
      : "inferred from logged sessions, not confirmed";
    sections.push(
      `NEXT SESSION (${qualifier}): ${day.dayName} [${day.workoutType}]${provenance}${exercises ? ` — ${exercises}` : ""}`,
    );
  } else if (context.plannedSessionsThisWeek > 0) {
    sections.push(
      "NEXT SESSION: every session planned for this week is already logged.",
    );
  }

  if (context.plannedSessionsThisWeek > 0) {
    const remaining = context.remainingSessions.length
      ? `; remaining: ${context.remainingSessions.join(", ")}`
      : "";
    const rest = context.restDaysThisWeek
      ? `; ${context.restDaysThisWeek} rest days`
      : "";
    sections.push(
      `THIS WEEK: ${context.sessionsLoggedThisWeek} of ${context.plannedSessionsThisWeek} sessions logged${remaining}${rest}.`,
    );
  }

  if (context.recentFeedback.length > 0) {
    sections.push(`RECENT SESSIONS: ${context.recentFeedback.join(" | ")}`);
  }

  let block = "";
  for (const section of sections) {
    const candidate = block ? `${block}\n${section}` : section;
    if (candidate.length > maxChars) break;
    block = candidate;
  }

  return block;
};

/**
 * Load the athlete's training state and render it for the prompt.
 *
 * Three bounded, indexed reads in parallel — this runs on every coach message, so it must not
 * become the reason a reply feels slow.
 *
 * @param {any} userId
 * @param {Date} [now]
 * @returns {Promise<string>} "" when there is no plan, which geminiService reads as "omit the
 *   routine block entirely"
 */
export const buildRoutineContext = async (userId, now = new Date()) => {
  const since = new Date(now.getTime() - LOG_LOOKBACK_MS);

  const [plan, strengthLogs, runLogs] = await Promise.all([
    findActivePlan(userId),
    findRecentStrengthSessions(userId, since, LOG_FETCH_LIMIT),
    findRecentRunSessions(userId, since, LOG_FETCH_LIMIT),
  ]);

  return formatRoutineContext(
    deriveRoutineContext({ plan, strengthLogs, runLogs, now }),
    { maxChars: routineMaxChars() },
  );
};
