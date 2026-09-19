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

const router = express.Router();

// The onboarding plan is the one free generation (FREE_PLAN_LIMIT), so a new user completes
// onboarding without paying. Regenerating afterwards requires premium.
router.post(
  "/generate-plan",
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
// routes leave their reads open.
router.get("/chat/history", protect, getChatHistory);

export default router;
