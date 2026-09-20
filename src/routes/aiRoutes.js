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
  requireActiveAccess,
  requirePlanQuota,
  generatePlan,
);

// Importing counts against the same FREE_PLAN_LIMIT as generating: a free user gets one plan,
// whether the AI wrote all of it or only the half they were missing. The oversized body parser
// this route needs is mounted by path in app.js, before the global express.json().
router.post(
  "/import-plan",
  generativeLimiter,
  protect,
  requireActiveAccess,
  requirePlanQuota,
  importPlan,
);

router.post(
  "/chat",
  protect,
  requireActiveAccess,
  requireChatQuota,
  chatWithCoach,
);

// Reading the conversation back is deliberately NOT behind the entitlement guards: an athlete
// whose trial has lapsed still owns everything they have already said, exactly as the workout
// routes leave their reads open. It is still rate-limited — `aiLimiter` above covers every route
// on this router — because it authenticates a caller and reads the database on each call.
router.get("/chat/history", protect, getChatHistory);

export default router;
