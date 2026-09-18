/**
 * Silence console.error/console.warn/console.log for a suite that deliberately drives a logging failure path.
 *
 * Several suites exercise handlers that log before responding (the auth middleware's invalid
 * token branch, the plan controller's catch blocks, the RTDN handler swallowing a Play outage).
 * Without this the run's output is buried in expected stack traces and a real failure is hard to
 * spot. Returns the spies so a test can still assert the logging happened.
 *
 * Lives here rather than in setupAfterEnv.js because importing that file from a suite would
 * re-run it and register its hooks a second time.
 */
export const silenceConsole = () => {
  const spies = {};

  beforeEach(() => {
    spies.error = jest.spyOn(console, "error").mockImplementation(() => {});
    spies.warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    spies.log = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    spies.error?.mockRestore();
    spies.warn?.mockRestore();
    spies.log?.mockRestore();
  });

  return spies;
};
