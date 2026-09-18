// Canonical mock for the google-auth-library package.
//
// Both authController.js and billingController.js do `new OAuth2Client()` at module load, which
// happens while the hoisted imports run — before any const in the test file has initialised.
// That is why the constructors return objects whose methods are arrows delegating to the shared
// jest.fn()s: the lookup is deferred to call time, so nothing is read from the temporal dead
// zone. Replacing the arrows with the jest.fn()s directly reintroduces the TDZ crash.
//
// The copy in auth.test.js also baked its Google payload into a closure, so no test could change
// it. Here verifyIdToken is a bare jest.fn() and each test installs the payload it needs — which
// is what lets the account-linking tests carry a dynamically generated email.

export const verifyIdToken = jest.fn();
export const getClient = jest.fn();

export const create = () => ({
  OAuth2Client: jest.fn(() => ({
    verifyIdToken: (...args) => verifyIdToken(...args),
  })),
  GoogleAuth: jest.fn(() => ({
    getClient: (...args) => getClient(...args),
  })),
});

/** Install a successful Google Sign-In payload. Pass the email the test just generated. */
export const givenGoogleUser = ({
  sub = "google-123",
  email,
  name = "Google User",
} = {}) => {
  verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub, email, name }) });
};

export const resetGoogleAuthMocks = () => {
  verifyIdToken.mockReset();
  getClient.mockReset();
};
