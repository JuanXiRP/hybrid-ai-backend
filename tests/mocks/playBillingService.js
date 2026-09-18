// Canonical mock for src/services/playBillingService.js.
//
// Both copies this replaces omitted PlayBillingError and resetAuthCache, so any code path that
// did `catch (e) { if (e instanceof PlayBillingError) ... }` silently took the wrong branch.

export const isBillingEnabled = jest.fn(() => false);
export const getSubscription = jest.fn();
export const acknowledgeSubscription = jest.fn();
export const resetAuthCache = jest.fn();

// The real class, so `instanceof` keeps meaning something in code under test. requireActual is
// required here: a plain import would resolve back through this very mock's registry entry.
// Pulling the real module in is safe because it constructs nothing at load time — the GoogleAuth
// instance is created lazily inside getAuth().
const { PlayBillingError } = jest.requireActual(
  "../../src/services/playBillingService.js",
);

export { PlayBillingError };

export const create = () => ({
  PlayBillingError,
  isBillingEnabled,
  getSubscription,
  acknowledgeSubscription,
  resetAuthCache,
});

export const resetPlayBillingMocks = () => {
  isBillingEnabled.mockReset().mockReturnValue(false);
  getSubscription.mockReset();
  acknowledgeSubscription.mockReset().mockResolvedValue(undefined);
  resetAuthCache.mockReset();
};
