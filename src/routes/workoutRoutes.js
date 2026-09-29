import express from "express";
import {
  createStrengthWorkout,
  createRunWorkout,
  upsertStrengthWorkout,
} from "../controllers/workoutController.js";
import { protect } from "../middleware/authMiddleware.js";
import { requireActiveAccess } from "../middleware/entitlementMiddleware.js";
import { workoutLimiter } from "../middleware/rateLimit.js";

const router = express.Router();

// Protected routes: they require a valid Bearer token from the Android client.
// Writes stop once the free trial expires; reads (GET /api/plans/*) stay open, so an expired
// user keeps their plan and history read-only.
router.post("/strength", protect, requireActiveAccess, createStrengthWorkout);
router.post("/run", protect, requireActiveAccess, createRunWorkout);

// Idempotent create-or-edit, keyed by a client-generated id. It is the path the app uses for a
// finished session and for editing a past one; the POST above stays for shipped clients.
router.put(
  "/strength/:clientId",
  workoutLimiter,
  protect,
  requireActiveAccess,
  upsertStrengthWorkout,
);

export default router;
