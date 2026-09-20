// One named factory per endpoint. No suite writes a URL: if /api/ai/chat becomes /api/v1/chat,
// the change is one line in routes.js and nothing else moves.
//
// Every factory takes the token first and returns the supertest request without awaiting it, so
// a caller can still chain (.expect(...), .set(...)) when it needs to. Passing token = null
// sends no Authorization header, which is how the 401 cases are written without duplicating the
// path.

import supertest from "supertest";
import app from "../../src/app.js";
import { bearer } from "./auth.js";
import { ROUTES } from "./routes.js";

const send = (method, path, token, body) => {
  const req = supertest(app)[method](path);
  if (token) req.set(bearer(token));
  return body === undefined ? req : req.send(body);
};

// --- auth ---------------------------------------------------------------------------------
export const makeRegisterRequest = (body) =>
  send("post", ROUTES.register, null, body);
export const makeLoginRequest = (body) =>
  send("post", ROUTES.login, null, body);
export const makeGoogleLoginRequest = (body) =>
  send("post", ROUTES.googleLogin, null, body);

// --- users --------------------------------------------------------------------------------
export const makeCreateUserRequest = (body) =>
  send("post", ROUTES.createUser, null, body);
export const makeUpdateProfileRequest = (token, body) =>
  send("patch", ROUTES.profile, token, body);
export const makeGetProfileRequest = (token) =>
  send("get", ROUTES.profile, token);

// --- ai -----------------------------------------------------------------------------------
export const makeAuthenticatedChatRequest = (token, body) =>
  send("post", ROUTES.chat, token, body);
export const makeChatHistoryRequest = (token, query = "") =>
  send("get", `${ROUTES.chatHistory}${query}`, token);
export const makeGeneratePlanRequest = (token, body) =>
  send("post", ROUTES.generatePlan, token, body);
export const makeImportPlanRequest = (token, body) =>
  send("post", ROUTES.importPlan, token, body);

// --- workouts -----------------------------------------------------------------------------
export const makeStrengthWorkoutRequest = (token, body) =>
  send("post", ROUTES.strengthWorkout, token, body);
export const makeRunWorkoutRequest = (token, body) =>
  send("post", ROUTES.runWorkout, token, body);

// --- plans --------------------------------------------------------------------------------
export const makeGetActivePlanRequest = (token) =>
  send("get", ROUTES.activePlan, token);
export const makeGetPlanHistoryRequest = (token) =>
  send("get", ROUTES.planHistory, token);

// --- billing ------------------------------------------------------------------------------
export const makeVerifyPurchaseRequest = (token, body) =>
  send("post", ROUTES.verifyPurchase, token, body);
export const makeEntitlementRequest = (token) =>
  send("get", ROUTES.entitlement, token);

// The RTDN endpoint is public and authenticates a Pub/Sub OIDC token inside the handler, not a
// user JWT — hence the distinct parameter name.
export const makeRtdnRequest = (oidcToken, body) =>
  send("post", ROUTES.rtdn, oidcToken, body);

// --- misc ---------------------------------------------------------------------------------
export const makeHealthRequest = () => send("get", ROUTES.health, null);
