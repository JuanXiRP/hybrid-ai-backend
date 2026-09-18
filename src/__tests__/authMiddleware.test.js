// The `protect` middleware guards every private route, but only its "no Bearer header" branch
// was covered — reached incidentally from another suite. The two branches that matter most in
// production (a validly-signed token for a deleted user, and a token that fails verification)
// had no test.

import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { makeGetProfileRequest } from "@test/helpers/api.js";
import { registerTestUser } from "@test/helpers/auth.js";
import { silenceConsole } from "@test/helpers/console.js";
import { useTestDatabase } from "@test/helpers/db.js";

useTestDatabase();

// The verification-failure branch logs the error before answering 401.
silenceConsole();

describe("protect", () => {
  it("rejects a request with no Authorization header", async () => {
    // Act
    const res = await makeGetProfileRequest(null);

    // Assert
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Not authorized, no token");
  });

  it("lets a valid token through", async () => {
    // Arrange
    const { token, email } = await registerTestUser();

    // Act
    const res = await makeGetProfileRequest(token);

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(email);
  });

  // Regression: a deleted account left req.user null and every controller then crashed on
  // req.user._id. The middleware has to answer 401 instead of letting that reach a handler.
  it("rejects a validly-signed token whose user no longer exists", async () => {
    // Arrange
    const { token } = await registerTestUser();
    await User.deleteMany();

    // Act
    const res = await makeGetProfileRequest(token);

    // Assert
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Not authorized, user not found");
  });

  it("rejects a token that is not a JWT at all", async () => {
    // Act
    const res = await makeGetProfileRequest("not-a-jwt");

    // Assert
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Not authorized, token failed");
  });

  // A token forged with the wrong secret must not be accepted, or the signing secret is
  // decorative.
  it("rejects a token signed with a different secret", async () => {
    // Arrange
    const { id } = await registerTestUser();
    const forged = jwt.sign({ id }, "not-the-real-secret", {
      expiresIn: "30d",
    });

    // Act
    const res = await makeGetProfileRequest(forged);

    // Assert
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Not authorized, token failed");
  });

  it("rejects an expired token", async () => {
    // Arrange
    const { id } = await registerTestUser();
    const expired = jwt.sign({ id }, process.env.JWT_SECRET, {
      expiresIn: "-1s",
    });

    // Act
    const res = await makeGetProfileRequest(expired);

    // Assert
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Not authorized, token failed");
  });
});
