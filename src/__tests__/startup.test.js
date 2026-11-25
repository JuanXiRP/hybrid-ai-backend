import mongoose from "mongoose";
import { assertRequiredEnv } from "../config/env.js";
import {
  makeAnonymousImportPlanRequest,
  makeHealthRequest,
  makeRemovedLegacyCreateUserRequest,
  makeUnknownRouteRequest,
} from "@test/helpers/api.js";

const validEnv = {
  MONGO_URI: "mongodb://localhost:27017/test",
  JWT_SECRET: "secret",
  GEMINI_API_KEY: "key",
  GOOGLE_WEB_CLIENT_ID: "client-id",
};

describe("assertRequiredEnv", () => {
  it("passes when every required variable is present", () => {
    // Act + Assert
    expect(() => assertRequiredEnv(validEnv)).not.toThrow();
  });

  it("names every missing variable in one go", () => {
    // Act + Assert - one restart per missing variable would be a miserable deploy loop
    expect(() => assertRequiredEnv({ JWT_SECRET: "secret" })).toThrow(
      /MONGO_URI, GEMINI_API_KEY/,
    );
  });

  it("treats a blank value as missing", () => {
    // Act + Assert
    expect(() => assertRequiredEnv({ ...validEnv, MONGO_URI: "   " })).toThrow(
      /MONGO_URI/,
    );
  });

  it("warns but does not throw when GOOGLE_WEB_CLIENT_ID is absent", () => {
    // Arrange
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { GOOGLE_WEB_CLIENT_ID, ...withoutClientId } = validEnv;

    // Act + Assert - Google Sign-In degrades, but the rest of the API still works
    expect(() => assertRequiredEnv(withoutClientId)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("GOOGLE_WEB_CLIENT_ID"),
    );

    warn.mockRestore();
  });

  describe("in production", () => {
    const productionEnv = {
      ...validEnv,
      NODE_ENV: "production",
      JWT_SECRET: "x".repeat(32),
    };

    it("accepts a 32-character JWT_SECRET", () => {
      // Act + Assert
      expect(() => assertRequiredEnv(productionEnv)).not.toThrow();
    });

    it("refuses a JWT_SECRET shorter than 32 characters without printing it", () => {
      // Arrange
      const shortSecret = "short-secret-value";

      // Act
      const attempt = () =>
        assertRequiredEnv({ ...productionEnv, JWT_SECRET: shortSecret });

      // Assert
      expect(attempt).toThrow(/JWT_SECRET must be at least 32 characters/);
      expect(attempt).not.toThrow(new RegExp(shortSecret));
    });

    it("refuses a missing GOOGLE_WEB_CLIENT_ID instead of warning", () => {
      // Arrange
      const { GOOGLE_WEB_CLIENT_ID, ...withoutClientId } = productionEnv;

      // Act + Assert
      expect(() => assertRequiredEnv(withoutClientId)).toThrow(
        /GOOGLE_WEB_CLIENT_ID must be set in production/,
      );
    });
  });

  it("does not enforce the secret length outside production", () => {
    // Act + Assert - CI runs with a 14-character secret and NODE_ENV=test
    expect(() =>
      assertRequiredEnv({ ...validEnv, NODE_ENV: "test", JWT_SECRET: "short" }),
    ).not.toThrow();
  });
});

// This suite deliberately does NOT call useTestDatabase(): it needs no live connection, and the
// cases below are exactly the ones a working server cannot be made to produce on demand — a
// closed socket, a rejected ping, and a ping that never settles at all.
describe("GET /health", () => {
  const stubConnection = ({ readyState, ping }) => {
    Object.defineProperty(mongoose.connection, "readyState", {
      value: readyState,
      configurable: true,
    });
    Object.defineProperty(mongoose.connection, "db", {
      value: { admin: () => ({ ping }) },
      configurable: true,
    });
  };

  afterEach(() => {
    delete mongoose.connection.readyState;
    delete mongoose.connection.db;
  });

  it("reports DEGRADED when the driver is not connected", async () => {
    // Arrange
    const ping = jest.fn();
    stubConnection({ readyState: 0, ping });

    // Act
    const res = await makeHealthRequest();

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("DEGRADED");
    expect(res.body.database).toBe("down");
    // Short-circuits: no point pinging a socket we know is closed.
    expect(ping).not.toHaveBeenCalled();
  });

  it("reports UP when Mongo answers the ping", async () => {
    // Arrange
    stubConnection({
      readyState: 1,
      ping: jest.fn().mockResolvedValue({ ok: 1 }),
    });

    // Act
    const res = await makeHealthRequest();

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("UP");
    expect(res.body.database).toBe("connected");
  });

  it("reports DEGRADED when the ping fails, even though readyState claims connected", async () => {
    // Arrange
    stubConnection({
      readyState: 1,
      ping: jest.fn().mockRejectedValue(new Error("connection reset")),
    });

    // Act
    const res = await makeHealthRequest();

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.database).toBe("down");
  });

  it("does not hang forever when the ping never settles", async () => {
    // Arrange
    stubConnection({
      readyState: 1,
      ping: jest.fn(() => new Promise(() => {})),
    });

    // Act
    const res = await makeHealthRequest();

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.database).toBe("down");
  }, 10000);
});

// None of these needs a database: each is answered before any handler touches Mongo.
describe("JSON error handling and routing", () => {
  it("answers an unknown route with a JSON 404", async () => {
    // Act
    const res = await makeUnknownRouteRequest();

    // Assert
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, message: "Not found" });
  });

  it("no longer serves the removed legacy POST /api/users", async () => {
    // Act
    const res = await makeRemovedLegacyCreateUserRequest({
      name: "x",
      email: "x",
      password: "password123",
    });

    // Assert
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("answers an anonymous import-plan with 401 before parsing its body", async () => {
    // Arrange - just over the 100 kb default limit: a parsed body would be a 413, not a 401
    const body = { sourceText: "a".repeat(150 * 1024) };

    // Act
    const res = await makeAnonymousImportPlanRequest(body);

    // Assert
    expect(res.status).toBe(401);
  });
});
