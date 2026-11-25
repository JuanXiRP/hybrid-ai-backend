// src/routes/aiRoutes.js
import express from "express";
import {
  generatePlan,
  importPlan,
  chatWithCoach,
  getChatHistory,
} from "../controllers/aiController.js";
import { protect } from "../middleware/authMiddleware.js";
import {
  requireActiveAccess,
  requirePlanQuota,
  requireChatQuota,
} from "../middleware/entitlementMiddleware.js";
import { aiLimiter, generativeLimiter } from "../middleware/rateLimit.js";
import { singleFlight } from "../middleware/singleFlight.js";
import { validateBody } from "../validation/validateBody.js";
import {
  chatSchema,
  generatePlanSchema,
  importPlanSchema,
} from "../validation/schemas.js";

const router = express.Router();

// Per-IP abuse ceiling for the whole AI surface, distinct from the per-user freemium quota the
// entitlement guards below enforce: a premium athlete is unlimited by quota but not by this.
router.use(aiLimiter);

// The onboarding plan is the one free generation (FREE_PLAN_LIMIT), so a new user completes
// onboarding without paying. Regenerating afterwards requires premium.
router.post(
  "/generate-plan",
  generativeLimiter,
  protect,
  singleFlight("plan"),
  requireActiveAccess,
  requirePlanQuota,
  validateBody(generatePlanSchema),
  generatePlan,
);

// Importing counts against the same FREE_PLAN_LIMIT as generating: a free user gets one plan,
// whether the AI wrote all of it or only the half they were missing. The oversized body parser
// this route needs is mounted here, AFTER `protect` (app.js skips this path in its default
// parser), so an anonymous caller can never make the server buffer 12 MB. `protect` only reads
// headers, so it works on a body that has not been parsed yet.
router.post(
  "/import-plan",
  generativeLimiter,
  protect,
  singleFlight("plan"),
  express.json({ limit: "12mb" }),
  requireActiveAccess,
  requirePlanQuota,
  validateBody(importPlanSchema),
  importPlan,
);

router.post(
  "/chat",
  protect,
  singleFlight("chat"),
  requireActiveAccess,
  requireChatQuota,
  validateBody(chatSchema),
  chatWithCoach,
);

// Reading the conversation back is deliberately NOT behind the entitlement guards: an athlete
// whose trial has lapsed still owns everything they have already said, exactly as the workout
// routes leave their reads open. It is still rate-limited — `aiLimiter` above covers every route
// on this router — because it authenticates a caller and reads the database on each call.
router.get("/chat/history", protect, getChatHistory);

export default router;
