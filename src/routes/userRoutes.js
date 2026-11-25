import express from "express";
import {
  updateUserProfile,
  getUserProfile,
} from "../controllers/userController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// Private route to update onboarding profile data
router.patch("/profile", protect, updateUserProfile);

// Private route to fetch profile metadata for the Settings screen
router.get("/profile", protect, getUserProfile);

export default router;
