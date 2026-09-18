// Canonical mock for src/services/geminiService.js.
//
// The three ad-hoc copies this replaces each declared a DIFFERENT subset of the module's
// exports, so a controller calling the omitted one got `undefined is not a function` — or
// worse, a test passed because the call silently never happened. This list is the module's
// real export surface and must stay in step with it.
//
// Used from a suite like this:
//
//   jest.mock('../services/geminiService.js', () =>
//     require('@test/mocks/geminiService.js').create(),
//   );
//
// `require` inside the factory is what makes the shared module usable at all: babel-plugin-jest-
// hoist lifts jest.mock above the imports, so a top-level `import` of this file would not have
// been evaluated yet when the factory runs. `require` is on the plugin's allow-list and resolves
// on demand, which sidesteps the temporal dead zone entirely.

export const generateWorkoutPlan = jest.fn();
export const importAndCompleteWorkoutPlan = jest.fn();
export const processChatMessage = jest.fn();

export const create = () => ({
  generateWorkoutPlan,
  importAndCompleteWorkoutPlan,
  processChatMessage,
});

/**
 * Full reset, including any *Once queues, then reinstall the defaults.
 *
 * The global beforeEach only calls clearAllMocks, which drops recorded calls but leaves both
 * implementations and queued one-shot values in place. A suite that queues mockResolvedValueOnce
 * needs this stronger reset, and because mockReset also destroys the implementation, the
 * defaults have to be put back here rather than relying on the jest.fn() declaration above.
 */
export const resetGeminiMocks = () => {
  generateWorkoutPlan.mockReset();
  importAndCompleteWorkoutPlan.mockReset();
  processChatMessage.mockReset();
};
