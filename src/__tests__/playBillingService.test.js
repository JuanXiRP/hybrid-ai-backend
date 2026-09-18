// The only suite that exercises playBillingService for real. Everywhere else it is mocked at the
// module boundary, which left it at 0% branch and function coverage despite being the module
// that decides whether a paying user keeps their subscription.
//
// google-auth-library is mocked instead, so the service's own logic — credential decoding, auth
// caching, URL construction, the entitled-state rules and error wrapping — runs unmodified.
jest.mock("google-auth-library", () =>
  require("@test/mocks/googleAuthLibrary.js").create(),
);

import { GoogleAuth } from "google-auth-library";
import {
  PlayBillingError,
  acknowledgeSubscription,
  getSubscription,
  isBillingEnabled,
  resetAuthCache,
} from "../services/playBillingService.js";
import { getClient } from "@test/mocks/googleAuthLibrary.js";

const PACKAGE = "com.hybridai.training";
const TOKEN = "token/with+special=chars";
const SUBSCRIPTION_ID = "hybrid ai pro";

// A syntactically valid service account, base64-encoded the way the deploy host supplies it.
const CREDENTIALS = Buffer.from(
  JSON.stringify({
    client_email: "svc@project.iam.gserviceaccount.com",
    private_key:
      "-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\n",
  }),
).toString("base64");

const inOneMonth = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const yesterday = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

let request;
const ENV_KEYS = [
  "BILLING_ENABLED",
  "PLAY_PACKAGE_NAME",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
];
let savedEnv;

// Test files in a worker share one process.env, so anything mutated here has to be put back.
beforeAll(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.PLAY_PACKAGE_NAME = PACKAGE;
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = CREDENTIALS;

  request = jest.fn().mockResolvedValue({ data: {} });
  getClient.mockResolvedValue({ request });

  // The module memoises its GoogleAuth instance; without this every test after the first would
  // reuse the credentials the first one happened to install.
  resetAuthCache();
});

describe("isBillingEnabled", () => {
  it('is true only for the exact string "true"', () => {
    process.env.BILLING_ENABLED = "true";
    expect(isBillingEnabled()).toBe(true);

    process.env.BILLING_ENABLED = "false";
    expect(isBillingEnabled()).toBe(false);

    delete process.env.BILLING_ENABLED;
    expect(isBillingEnabled()).toBe(false);
  });
});

describe("configuration failures", () => {
  it("refuses to build a URL when PLAY_PACKAGE_NAME is missing", async () => {
    // Arrange
    delete process.env.PLAY_PACKAGE_NAME;

    // Act + Assert
    await expect(getSubscription(TOKEN)).rejects.toThrow(PlayBillingError);
    await expect(getSubscription(TOKEN)).rejects.toMatchObject({
      name: "PlayBillingError",
      status: null,
    });

    // It fails before any network work is attempted.
    expect(getClient).not.toHaveBeenCalled();
  });

  // This is also the only way to reach the `error instanceof PlayBillingError` rethrow inside
  // request(): a config error raised by getAuth() must surface as-is, not wrapped as an API fault.
  it("reports missing service account credentials without wrapping them as an API error", async () => {
    // Arrange
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    // Act + Assert
    await expect(getSubscription(TOKEN)).rejects.toThrow(
      /GOOGLE_SERVICE_ACCOUNT_JSON is not configured/,
    );
    await expect(getSubscription(TOKEN)).rejects.toMatchObject({
      status: null,
    });
  });

  it("reports credentials that are not valid base64-encoded JSON", async () => {
    // Arrange — Buffer.from tolerates this, so it is JSON.parse that actually fails
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "not-base64-json";

    // Act + Assert
    await expect(getSubscription(TOKEN)).rejects.toThrow(
      /not valid base64-encoded JSON/,
    );
  });
});

describe("auth caching", () => {
  it("builds the GoogleAuth client once and reuses it until the cache is reset", async () => {
    // Act
    await getSubscription(TOKEN);
    await getSubscription(TOKEN);

    // Assert
    expect(GoogleAuth).toHaveBeenCalledTimes(1);
    expect(GoogleAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({
          client_email: "svc@project.iam.gserviceaccount.com",
        }),
        scopes: ["https://www.googleapis.com/auth/androidpublisher"],
      }),
    );

    // Act — a reset forces the next call to rebuild it
    resetAuthCache();
    await getSubscription(TOKEN);

    // Assert
    expect(GoogleAuth).toHaveBeenCalledTimes(2);
  });
});

describe("getSubscription", () => {
  const givenPlayResponse = (data) => request.mockResolvedValue({ data });

  it("maps an active subscription and targets the subscriptionsv2 endpoint", async () => {
    // Arrange
    const expiry = inOneMonth();
    givenPlayResponse({
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      lineItems: [
        {
          expiryTime: expiry.toISOString(),
          productId: "hybrid_ai_pro_monthly",
        },
      ],
      latestOrderId: "GPA.1234",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
      testPurchase: {},
    });

    // Act
    const result = await getSubscription(TOKEN);

    // Assert
    expect(result).toEqual({
      state: "SUBSCRIPTION_STATE_ACTIVE",
      isActive: true,
      expiryTime: expiry,
      productId: "hybrid_ai_pro_monthly",
      orderId: "GPA.1234",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
      isAcknowledged: true,
      isTestPurchase: true,
    });

    // The token carries "/" and "+", which must be escaped or the path is corrupted.
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      url: expect.stringContaining(
        `/applications/${PACKAGE}/purchases/subscriptionsv2/tokens/${encodeURIComponent(TOKEN)}`,
      ),
    });
  });

  // Grace period is still entitled: Google keeps serving the subscription while a renewal
  // payment is retried, so revoking there would lock out a paying user over a card hiccup.
  it.each([
    ["SUBSCRIPTION_STATE_ACTIVE", "future", true],
    ["SUBSCRIPTION_STATE_IN_GRACE_PERIOD", "future", true],
    ["SUBSCRIPTION_STATE_CANCELED", "future", false],
    ["SUBSCRIPTION_STATE_ON_HOLD", "future", false],
    ["SUBSCRIPTION_STATE_PAUSED", "future", false],
    ["SUBSCRIPTION_STATE_ACTIVE", "past", false],
    ["SUBSCRIPTION_STATE_IN_GRACE_PERIOD", "past", false],
  ])(
    "treats %s expiring in the %s as isActive=%s",
    async (state, when, expected) => {
      // Arrange
      const expiryTime = when === "future" ? inOneMonth() : yesterday();
      givenPlayResponse({
        subscriptionState: state,
        lineItems: [{ expiryTime: expiryTime.toISOString() }],
      });

      // Act
      const result = await getSubscription(TOKEN);

      // Assert
      expect(result.isActive).toBe(expected);
    },
  );

  it("is not active when Play returns no line items", async () => {
    // Arrange — a subscription always has one in our single-product setup, but the code must
    // not throw if that ever stops holding.
    givenPlayResponse({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE" });

    // Act
    const result = await getSubscription(TOKEN);

    // Assert
    expect(result.expiryTime).toBeNull();
    expect(result.productId).toBeNull();
    expect(result.isActive).toBe(false);
  });

  it("defaults every optional field when Play returns an empty body", async () => {
    // Arrange
    givenPlayResponse({});

    // Act
    const result = await getSubscription(TOKEN);

    // Assert
    expect(result).toEqual({
      state: null,
      isActive: false,
      expiryTime: null,
      productId: null,
      orderId: null,
      acknowledgementState: null,
      isAcknowledged: false,
      isTestPurchase: false,
    });
  });
});

describe("error wrapping", () => {
  it("carries the HTTP status through when Play answers with one", async () => {
    // Arrange
    request.mockRejectedValue(
      Object.assign(new Error("subscription not found"), {
        response: { status: 410 },
      }),
    );

    // Act + Assert
    await expect(getSubscription(TOKEN)).rejects.toMatchObject({
      name: "PlayBillingError",
      status: 410,
      message: expect.stringContaining("(HTTP 410)"),
    });
  });

  it("reports a transport failure with a null status and no HTTP fragment", async () => {
    // Arrange — a socket error never reaches an HTTP response
    request.mockRejectedValue(new Error("socket hang up"));

    // Act + Assert
    const error = await getSubscription(TOKEN).catch((e) => e);
    expect(error).toBeInstanceOf(PlayBillingError);
    expect(error.status).toBeNull();
    expect(error.message).not.toContain("(HTTP");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("wraps a failure to mint the access token", async () => {
    // Arrange
    getClient.mockRejectedValue(new Error("invalid_grant"));

    // Act + Assert
    await expect(getSubscription(TOKEN)).rejects.toThrow(PlayBillingError);
  });
});

describe("acknowledgeSubscription", () => {
  // Google auto-refunds an unacknowledged purchase after three days, so this call has to reach
  // the right URL — and it is the v1 endpoint, because subscriptionsv2 has no acknowledge method.
  it("POSTs to the v1 acknowledge endpoint with both ids escaped", async () => {
    // Act
    await acknowledgeSubscription(SUBSCRIPTION_ID, TOKEN);

    // Assert
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      url: expect.stringContaining(
        `/purchases/subscriptions/${encodeURIComponent(SUBSCRIPTION_ID)}/tokens/${encodeURIComponent(TOKEN)}:acknowledge`,
      ),
    });
  });

  it("surfaces a Play failure rather than silently succeeding", async () => {
    // Arrange
    request.mockRejectedValue(
      Object.assign(new Error("forbidden"), { response: { status: 403 } }),
    );

    // Act + Assert
    await expect(
      acknowledgeSubscription(SUBSCRIPTION_ID, TOKEN),
    ).rejects.toMatchObject({ status: 403 });
  });
});
