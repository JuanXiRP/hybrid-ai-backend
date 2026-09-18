// Runs inside each test file's environment, before the file body is evaluated.

// The in-memory Mongo connection and the first supertest round-trip are slow enough on a cold
// worker that the 5s default flakes.
jest.setTimeout(30000);

// clearAllMocks, NOT resetAllMocks. In jest-mock 30, mockReset() deletes the mock's entry from
// the config registry, and jest.fn(impl) stores impl in that same registry — so resetAllMocks
// would wipe the implementations that suites install in their jest.mock factories
// (e.g. `processChatMessage: jest.fn().mockResolvedValue('AI reply')`), and those suites would
// start getting undefined back. mockClear only drops recorded calls, which is what per-test
// isolation actually needs.
//
// Registered here rather than via the `clearMocks` config flag so the ordering is explicit:
// hooks from setupFilesAfterEnv land on the root describe block before the test file body runs,
// and root-level beforeEach hooks fire in registration order. That guarantees this clear runs
// BEFORE each suite's own beforeEach, which is exactly what the suites that re-install mock
// implementations depend on.
beforeEach(() => {
  jest.clearAllMocks();
});
