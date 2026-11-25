// One zod schema per validated route. See validateBody.js for how they are applied.
//
// Principle: allowlist what the shipped Android client sends (its DTOs are the contract), type
// every field strictly enough that an object can never stand in for a string, and leave
// domain rules that Mongoose already enforces (enums, ranges) to Mongoose.

import { z } from "zod";
import User from "../models/User.js";

const MAX_EMAIL_LENGTH = 254;
// bcrypt only reads the first 72 bytes, and hashing an unbounded string is a CPU DoS.
const MAX_PASSWORD_LENGTH = 128;
const MAX_CHAT_MESSAGE_LENGTH = 4000;
const MAX_GPS_POINTS = 20000;

const GOALS = User.schema.path("goal").enumValues;
const PLAN_DURATIONS = [4, 8, 12];

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(MAX_EMAIL_LENGTH)
  .pipe(z.email());

// The profile fields registerUser forwards to Mongoose. Loosely typed on purpose: the schema
// there owns the enums and ranges, and the app does not validate these client-side.
const looseScalar = z.union([z.string().max(100), z.number()]);

export const registerSchema = z.object({
  email,
  password: z.string().min(6).max(MAX_PASSWORD_LENGTH),
  name: z.string().max(100).optional(),
  age: looseScalar.optional(),
  height: looseScalar.optional(),
  weight: looseScalar.optional(),
  sex: looseScalar.optional(),
  goal: looseScalar.optional(),
  fitnessLevel: looseScalar.optional(),
  daysAvailable: looseScalar.optional(),
  planDuration: looseScalar.optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(MAX_EMAIL_LENGTH),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export const googleLoginSchema = z.object({
  idToken: z.string().min(1).max(4096),
});

export const generatePlanSchema = z.object({
  planDuration: z
    .number()
    .refine((value) => PLAN_DURATIONS.includes(value), {
      message: "must be one of 4, 8, 12",
    })
    .optional(),
  goal: z.enum(GOALS).optional(),
});

// Import carries the same two overrides as generation; the source material is validated by the
// controller (validateImportPayload), so it passes through here untouched.
export const importPlanSchema = generatePlanSchema.extend({
  providedDomain: z.unknown().optional(),
  sourceText: z.unknown().optional(),
  attachments: z.unknown().optional(),
});

export const chatSchema = z.object({
  message: z
    .string({ error: "Message is required" })
    .trim()
    .min(1, "Message is required")
    .max(MAX_CHAT_MESSAGE_LENGTH),
  // Still accepted because shipped builds send them; deliberately ignored by the controller.
  plan_context: z.unknown().optional(),
  history: z.unknown().optional(),
});

const nullableNumber = z.number().nullable().optional();

export const runWorkoutSchema = z.object({
  date: z.union([z.string().max(64), z.number()]).optional(),
  distance: z.number({ error: "Distance is required" }).min(0),
  duration: z.number({ error: "Duration is required" }).min(0),
  targetPace: z.number({ error: "Target pace is required" }),
  actualPace: nullableNumber,
  elevationGain: nullableNumber,
  rpe: nullableNumber,
  gpsPath: z
    .array(z.object({ lat: z.number(), lng: z.number() }))
    .max(MAX_GPS_POINTS)
    .optional(),
  weekNumber: z.number().int().min(1).nullable().optional(),
  dayIndex: z.number().int().min(0).nullable().optional(),
  isExtra: z.boolean().optional(),
  // The app sends a placeholder; the controller overwrites it with the authenticated user.
  userId: z.unknown().optional(),
});

// Same any-UUID rule as the upsert path in workoutController.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Legacy POST /api/workouts/strength: the upsert allowlist plus an optional clientId. The nested
// shapes are left loose — Mongoose validates `exercises` — but `planId` and `_id` are not named,
// so zod strips them.
export const strengthWorkoutSchema = z.object({
  routineType: z.string().max(200).optional(),
  date: z.union([z.string().max(64), z.number()]).optional(),
  startedAt: z.union([z.string().max(64), z.number()]).optional(),
  durationSec: z.number().optional(),
  notes: z.string().optional(),
  weekNumber: z.number().nullable().optional(),
  dayIndex: z.number().nullable().optional(),
  isExtra: z.boolean().optional(),
  exercises: z.array(z.unknown()).optional(),
  clientId: z.string().regex(UUID_PATTERN).optional(),
  userId: z.unknown().optional(),
});
