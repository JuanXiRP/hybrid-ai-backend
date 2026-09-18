// Per-suite half of the database lifecycle. globalSetup.cjs owns the mongod process; this owns
// the connection, the indexes and the between-test cleanup.

import mongoose from "mongoose";

// Importing all five models here is load-bearing, not tidiness. `mongoose.connection.collections`
// only contains models that have actually been registered, so a dynamic wipe is only complete if
// every model has been imported first. Registering them centrally is what makes the dynamic loop
// below correct for every suite, instead of silently skipping whichever models a given test file
// happened not to import.
import ChatHistory from "../../src/models/ChatHistory.js";
import User from "../../src/models/User.js";
import WorkoutPlan from "../../src/models/WorkoutPlan.js";
import WorkoutRun from "../../src/models/WorkoutRun.js";
import WorkoutStrength from "../../src/models/WorkoutStrength.js";

const MODELS = [ChatHistory, User, WorkoutPlan, WorkoutRun, WorkoutStrength];

// Each worker gets its own database inside the shared mongod, so suites running in parallel
// cannot see each other's documents or collide on a unique index.
const databaseName = () => `jest_${process.env.JEST_WORKER_ID ?? "1"}`;

export const connectTestDatabase = async () => {
  await mongoose.connect(`${process.env.MONGO_MEMORY_URI}${databaseName()}`);

  // Without syncIndexes the unique index on User.email is never built, so a duplicate-email
  // test would pass for the wrong reason. Two suites used to do this; now all of them do.
  await Promise.all(MODELS.map((model) => model.syncIndexes()));
};

export const clearCollections = async () => {
  const collections = Object.values(mongoose.connection.collections);
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
};

export const disconnectTestDatabase = async () => {
  // A worker runs several suites in sequence and reuses its database name, so the drop is what
  // keeps file N+1 from inheriting file N's leftovers.
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
};

/**
 * Opt-in database lifecycle. Call once at the top level of a suite that needs Mongo.
 *
 * It is a function call rather than something global in setupAfterEnv because startup.test.js
 * must NOT have a live connection — it stubs mongoose.connection to simulate a hanging ping,
 * which a real server cannot be made to do on demand.
 */
export const useTestDatabase = () => {
  beforeAll(connectTestDatabase);
  afterEach(clearCollections);
  afterAll(disconnectTestDatabase);
};
