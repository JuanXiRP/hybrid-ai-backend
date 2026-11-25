// src/controllers/userController.js
import User from "../models/User.js";

// The only fields a client may write through this endpoint. Entitlement state
// (isPremium, trialEndsAt, subscription) is owned exclusively by billingController and must
// never be settable from a request body — spreading req.body into a $set would let
// any authenticated user grant themselves premium.
const PROFILE_FIELDS = [
  "age",
  "weight",
  "height",
  "sex",
  "goal",
  "fitnessLevel",
  "daysAvailable",
  "planDuration",
  "injuries",
  "last_period_date",
];

const MAX_INJURIES = 20;
const MAX_TEXT_LENGTH = 100;

const pick = (source, allowedKeys) =>
  Object.fromEntries(
    allowedKeys
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );

// @desc    Update user profile with onboarding biometrics
// @route   PATCH /api/users/profile
// @access  Private (Requires JWT token)
export const updateUserProfile = async (req, res) => {
  try {
    // 1. Destructure expected payload for explicit validation
    const {
      age,
      weight,
      height,
      sex,
      goal,
      fitnessLevel,
      daysAvailable,
      planDuration,
    } = req.body;

    // 2. Strict API-level validation
    // Enforces that the onboarding payload is 100% complete before touching the database
    if (
      !age ||
      !weight ||
      !height ||
      !sex ||
      !goal ||
      !fitnessLevel ||
      !daysAvailable ||
      !planDuration
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Validation failed: All physical profile fields (age, weight, height, sex, goal, fitnessLevel, daysAvailable, planDuration) are strictly required.",
      });
    }

    // 2a. Free-text fields are bounded: they are stored and later interpolated into prompts.
    const { injuries } = req.body;
    if (
      injuries !== undefined &&
      (!Array.isArray(injuries) ||
        injuries.length > MAX_INJURIES ||
        injuries.some(
          (item) => typeof item !== "string" || item.length > MAX_TEXT_LENGTH,
        ))
    ) {
      return res.status(400).json({
        success: false,
        message: `Validation failed: injuries must be at most ${MAX_INJURIES} strings of ${MAX_TEXT_LENGTH} characters.`,
      });
    }
    const textFields = [sex, goal, fitnessLevel];
    if (
      textFields.some(
        (value) => typeof value === "string" && value.length > MAX_TEXT_LENGTH,
      )
    ) {
      return res.status(400).json({
        success: false,
        message: `Validation failed: text fields must be at most ${MAX_TEXT_LENGTH} characters.`,
      });
    }

    // 2b. Optional cycle-aware field: validate only when present (omitted for non-female users)
    const { last_period_date } = req.body;
    if (last_period_date !== undefined && last_period_date !== null) {
      const isIsoShape = /^\d{4}-\d{2}-\d{2}$/.test(last_period_date);
      const parsed = new Date(last_period_date);
      // Round-trip check rejects impossible calendar dates (e.g. 2026-02-30 → rolls over)
      const isValidCalendarDate =
        isIsoShape &&
        !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === last_period_date;

      if (!isValidCalendarDate) {
        return res.status(400).json({
          success: false,
          message:
            "Validation failed: last_period_date must be a valid ISO date (yyyy-MM-dd).",
        });
      }
      if (parsed.getTime() > Date.now()) {
        return res.status(400).json({
          success: false,
          message:
            "Validation failed: last_period_date cannot be in the future.",
        });
      }
    }

    // 3. Database operation
    // req.user.id is injected by JWT authentication middleware.
    // Only PROFILE_FIELDS are $set — never the raw body (see the allowlist above).
    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      {
        $set: {
          ...pick(req.body, PROFILE_FIELDS),
          hasCompletedOnboarding: true,
        },
      },
      { new: true, runValidators: true },
    );

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        message: "User not found in database",
      });
    }

    res.status(200).json({
      success: true,
      data: updatedUser,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// @desc    Get user profile data
// @route   GET /api/users/profile
// @access  Private
export const getUserProfile = async (req, res) => {
  try {
    // req.user is populated by the 'protect' middleware
    const user = await User.findById(req.user.id).select("-password");

    if (user) {
      res.status(200).json({
        success: true,
        data: user,
      });
    } else {
      res.status(404).json({ success: false, message: "User not found" });
    }
  } catch (error) {
    console.error("Error fetching user profile:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
