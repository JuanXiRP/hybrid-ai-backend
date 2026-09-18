// Boots ONE in-memory MongoDB for the whole run. Previously each suite created its own, which
// meant six mongod startups competing for the same machine — the contention jest.setup.js was
// papering over with a 30s timeout.
//
// CommonJS on purpose: mongodb-memory-server@11 ships plain CJS, and a .cjs file is loaded by
// Jest without going through the Babel transform at all.

const { MongoMemoryServer } = require("mongodb-memory-server");

// Workers are forked AFTER this runs, so anything set here is inherited by every worker.
// dotenv.config() never overwrites an already-set variable, which means pinning the test
// environment here also neutralises a developer's local .env (a stray BILLING_ENABLED=true
// would otherwise turn the suite red on their machine only).
const setEnv = (key, value) => {
  process.env[key] = value;
};
const defaultEnv = (key, value) => {
  if (!process.env[key]) process.env[key] = value;
};

module.exports = async () => {
  const server = await MongoMemoryServer.create();

  // globalSetup and globalTeardown share a realm, so the instance can be handed over directly.
  globalThis.__MONGO_SERVER__ = server;

  // Deliberately NOT named MONGO_URI: that name is what config/env.js asserts on and what
  // config/db.js would connect to. Tests drive the connection themselves.
  setEnv("MONGO_MEMORY_URI", server.getUri());

  setEnv("NODE_ENV", "test");
  defaultEnv("JWT_SECRET", "ci-test-secret");
  defaultEnv("GEMINI_API_KEY", "test-gemini-key");
  defaultEnv("GOOGLE_WEB_CLIENT_ID", "test-web-client-id");

  // Billing is off by default; the suites that need it on flip the mocked isBillingEnabled.
  setEnv("BILLING_ENABLED", "false");
  setEnv("PLAY_PACKAGE_NAME", "com.hybridai.training");
  setEnv(
    "PUBSUB_VERIFICATION_AUDIENCE",
    "https://example.test/api/billing/rtdn",
  );
  setEnv(
    "PUBSUB_SERVICE_ACCOUNT_EMAIL",
    "pubsub@project.iam.gserviceaccount.com",
  );

  // Pin the freemium limits so a test never depends on a default changing in entitlementService.
  setEnv("FREE_TRIAL_DAYS", "14");
  setEnv("FREE_PLAN_LIMIT", "1");
  setEnv("FREE_CHAT_MESSAGES_PER_DAY", "2");
};
