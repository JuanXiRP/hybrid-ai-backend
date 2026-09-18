// Account creation and the Bearer-header primitive. Request construction lives in api.js.

import { randomUUID } from "crypto";
import supertest from "supertest";
import app from "../../src/app.js";
import { ROUTES } from "./routes.js";

export const bearer = (token) => ({ Authorization: `Bearer ${token}` });

/**
 * Every test user gets a freshly generated email.
 *
 * There is deliberately no way to pass one in. Hard-coded addresses make a suite depend on its
 * own teardown never failing, and once workers run in parallel they collide on the unique index
 * outright. A test that needs to assert on the address captures the one this returns:
 *
 *   const { token, email } = await registerTestUser();
 *   expect(profile.email).toBe(email);
 */
export const registerTestUser = async ({
  name = "Test User",
  password = "password123",
} = {}) => {
  const email = `user-${randomUUID()}@example.test`;

  const res = await supertest(app)
    .post(ROUTES.register)
    .send({ name, email, password });

  if (!res.body?.token) {
    throw new Error(
      `registerTestUser failed (${res.status}): ${JSON.stringify(res.body)}`,
    );
  }

  // The register handler answers { success, token, data: { id, name, email } }.
  return { token: res.body.token, email, name, password, id: res.body.data.id };
};

export const loginToken = async (email, password) => {
  const res = await supertest(app).post(ROUTES.login).send({ email, password });
  return res.body.token;
};
