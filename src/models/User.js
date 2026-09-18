// src/models/User.js
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, "Name is required"], trim: true },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
    },
    googleId: { type: String, required: false },
    password: {
      type: String,
      required: [
        function () {
          return !this.googleId;
        },
        "Password is required",
      ], // 🟢 only required if not a Google user
      minlength: [6, "Password must be at least 6 characters"],
      select: false,
    },

    // Physical profile fields: Optional at registration, validated during Onboarding API call
    age: {
      type: Number,
      required: false,
      min: [16, "Age must be at least 16"],
    },
    weight: {
      type: Number,
      required: false,
      min: [30, "Weight must be greater than 30kg"],
    },
    height: {
      type: Number,
      required: false,
      min: [100, "Height must be greater than 100cm"],
    },
    sex: {
      type: String,
      enum: ["male", "female", "other"],
      required: false,
    },
    goal: {
      type: String,
      enum: {
        values: ["endurance", "strength", "both"],
        message: "{VALUE} is not a valid goal",
      },
      required: false,
    },
    fitnessLevel: {
      type: String,
      enum: {
        values: ["beginner", "intermediate", "advanced"],
        message: "{VALUE} is not a valid fitness level",
      },
      required: false,
    },
    daysAvailable: {
      type: Number,
      required: false,
      min: [1, "Must be at least 1 day"],
      max: [7, "Cannot exceed 7 days"],
    },
    planDuration: {
      type: Number,
      enum: {
        values: [4, 8, 12],
        message: "{VALUE} is not a valid duration. Choose 4, 8, or 12.",
      },
      required: false,
    },
    injuries: { type: [String], default: [] },
    // Cycle-aware onboarding: ISO yyyy-MM-dd string, stored verbatim to preserve the
    // hand-mirrored wire contract. Only sent by the client for female users.
    // FOLLOW-UP: already consumed by geminiService prompt; consider surfacing derived
    // cycle-phase annotations in the plan responseSchema if the app needs to render them.
    last_period_date: { type: String, required: false, default: null },

    // Free-tier usage window. Null means "derive from createdAt" (see entitlementService),
    // which keeps new users write-free. It is set explicitly only by the backfill script,
    // so users who predate the freemium model are not retroactively locked out on deploy.
    trialEndsAt: { type: Date, default: null },

    // Derived from `subscription` by billingController — never written from a request body.
    isPremium: { type: Boolean, default: false },

    // Mirror of the Google Play subscription. Google is the source of truth; this is a cache
    // refreshed on purchase, on restore, on RTDN, and on lazy revalidation past expiryTime.
    subscription: {
      purchaseToken: { type: String, default: null },
      productId: { type: String, default: null },
      orderId: { type: String, default: null },
      expiryTime: { type: Date, default: null },
      // One of the SUBSCRIPTION_STATE_* values returned by purchases.subscriptionsv2.get
      state: { type: String, default: null },
      acknowledged: { type: Boolean, default: false },
      lastVerifiedAt: { type: Date, default: null },
    },

    hasCompletedOnboarding: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Replay protection: a purchase token may back at most one account. Without this, a leaked
// token could be redeemed across arbitrarily many users.
//
// This must be a PARTIAL index, not a sparse one. `sparse` only skips documents where the
// field is absent, and every free user has an explicit `purchaseToken: null` from the schema
// default — a unique+sparse index would therefore collide on the second free user and break
// registration. Filtering on $type: "string" indexes only real tokens.
userSchema.index(
  { "subscription.purchaseToken": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "subscription.purchaseToken": { $type: "string" },
    },
  },
);

// Pre-save hook to hash the password before saving to the database
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// A Google-only account has no password at all (see the conditional `required` above), and
// bcrypt.compare THROWS on an undefined hash rather than returning false. Without this guard the
// throw escapes loginUser's try and the caller gets a 500 instead of a clean 401 — which locked a
// user out entirely: registering said "already exists" and logging in crashed.
//
// Also covers the case where the document was fetched without `.select('+password')`.
userSchema.methods.matchPassword = async function (enteredPassword) {
  if (!this.password) return false;
  return await bcrypt.compare(enteredPassword, this.password);
};

export default mongoose.model("User", userSchema);
