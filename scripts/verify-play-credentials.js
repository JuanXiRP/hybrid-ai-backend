// Phase 0.3 — prove the Play Developer API credentials work before trusting any of the
// billing code that depends on them. Run this after linking the service account in
// Play Console; the link takes 24-48h to propagate, and until it does every call 401s.
//
//   node scripts/verify-play-credentials.js [purchaseToken]
//
// Interpreting the result:
//   401 / invalid_grant  -> the service account key is wrong or the JSON is mis-encoded
//   403                  -> key is valid but not yet linked/permissioned in Play Console
//   404                  -> credentials WORK; the token just does not exist (expected here)
//   200                  -> credentials work and the token is real

import dotenv from "dotenv";
import { getSubscription, PlayBillingError } from "../src/services/playBillingService.js";

dotenv.config();

// A syntactically plausible token that will not exist. A 404 therefore proves we authenticated.
const PROBE_TOKEN = process.argv[2] ?? "probe-token-that-does-not-exist";

const required = ["PLAY_PACKAGE_NAME", "GOOGLE_SERVICE_ACCOUNT_JSON"];
const missing = required.filter((key) => !process.env[key]);

if (missing.length) {
  console.error(`Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Package:  ${process.env.PLAY_PACKAGE_NAME}`);
console.log(`Token:    ${PROBE_TOKEN}`);
console.log("");

try {
  const result = await getSubscription(PROBE_TOKEN);
  console.log("Authenticated, and the token resolved:");
  console.log(result);
} catch (error) {
  if (!(error instanceof PlayBillingError)) throw error;

  if (error.status === 404) {
    console.log("Credentials are VALID.");
    console.log("(404 = authenticated fine, the probe token simply does not exist.)");
    process.exit(0);
  }

  if (error.status === 403) {
    console.error("Credentials authenticate, but Play Console has not granted access.");
    console.error("Check: Play Console > Users & permissions > the service account has");
    console.error("'View financial data' on this app. Propagation takes 24-48h.");
    process.exit(1);
  }

  if (error.status === 401) {
    console.error("Authentication failed. The service account key is wrong or the");
    console.error("GOOGLE_SERVICE_ACCOUNT_JSON base64 blob is malformed.");
    process.exit(1);
  }

  console.error(error.message);
  process.exit(1);
}
