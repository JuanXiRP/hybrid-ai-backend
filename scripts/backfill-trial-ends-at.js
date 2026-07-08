// One-off migration: grandfather users who predate the freemium model.
//
// entitlementService derives a null `trialEndsAt` as `createdAt + FREE_TRIAL_DAYS`. For anyone
// who registered before this model shipped, that date is already in the past, so enabling the
// gating would drop every existing user straight into read-only mode. This script gives them a
// fresh window measured from the deploy instead.
//
// MUST run after deploying the model change and BEFORE the entitlement middleware is enabled.
// Idempotent: only touches users whose trialEndsAt is still unset.
//
//   node scripts/backfill-trial-ends-at.js          # apply
//   node scripts/backfill-trial-ends-at.js --dry-run # report only

import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../src/models/User.js";

dotenv.config();

const TRIAL_DAYS = Number(process.env.FREE_TRIAL_DAYS ?? 14);
const DRY_RUN = process.argv.includes("--dry-run");

const run = async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set. Refusing to run.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const filter = { trialEndsAt: null };
  const affected = await User.countDocuments(filter);

  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

  console.log(`Users without trialEndsAt: ${affected}`);
  console.log(`Would set trialEndsAt = ${trialEndsAt.toISOString()} (+${TRIAL_DAYS}d)`);

  if (DRY_RUN) {
    console.log("Dry run — nothing written.");
  } else {
    const result = await User.updateMany(filter, { $set: { trialEndsAt } });
    console.log(`Updated ${result.modifiedCount} user(s).`);
  }

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error("Backfill failed:", error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
