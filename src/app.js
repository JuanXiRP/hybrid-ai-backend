import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import cors from "cors";
import mongoose from "mongoose";
import userRoutes from "./routes/userRoutes.js";
import workoutRoutes from "./routes/workoutRoutes.js";
import aiRoutes from "./routes/aiRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import workoutPlanRoutes from "./routes/workoutPlanRoutes.js";
import billingRoutes from "./routes/billingRoutes.js";
import { globalLimiter } from "./middleware/rateLimit.js";

dotenv.config();

const app = express();

// Render terminates TLS and forwards, so without this every request looks like it comes from the
// proxy: req.ip would be the proxy's address and the rate limiters below would put ALL users in
// one bucket, letting a single abuser lock out everybody. `1` — exactly one hop — rather than
// `true`, which would trust a client-supplied X-Forwarded-For and make the limits spoofable.
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors());

// The app-wide ceiling. Mounted before the routers so every route inherits it, including the
// ones whose own limiter is stricter.
app.use(globalLimiter);

// The default 100 kb parser. Plan import carries a base64 PDF or photo and needs a far wider
// one, but that parser is mounted inside aiRoutes AFTER authentication, so an anonymous caller can
// never make the server buffer 12 MB. This one steps aside for that exact path.
const defaultJson = express.json();
app.use((req, res, next) =>
  req.path === "/api/ai/import-plan" ? next() : defaultJson(req, res, next),
);

const DB_PING_TIMEOUT_MS = 2000;

const withTimeout = (promise, ms) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("ping timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * A real round-trip to Mongo, not just readyState.
 *
 * readyState reports what the driver believes, which stays optimistic for a while after a cluster
 * becomes unreachable — the old /health returned UP while the database was dead. The ping also
 * doubles as the keep-alive touch: a scheduled request to this endpoint is what stops Atlas from
 * counting the deployment as idle and pausing the free cluster.
 */
const checkDatabase = async () => {
  if (mongoose.connection.readyState !== 1) return "down";

  try {
    await withTimeout(
      mongoose.connection.db.admin().ping(),
      DB_PING_TIMEOUT_MS,
    );
    return "connected";
  } catch {
    return "down";
  }
};

// Deliberately 200 even when the database is down: during a transient Mongoose reconnect a 503
// would make the host restart the service in a loop. Flip this to 503 only if you wire it up as a
// host health check path and actually want that restart.
app.get("/health", async (req, res) => {
  const database = await checkDatabase();

  res.status(200).json({
    status: database === "connected" ? "UP" : "DEGRADED",
    environment: process.env.NODE_ENV,
    database,
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/users", userRoutes);
app.use("/api/workouts", workoutRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/plans", workoutPlanRoutes);
app.use("/api/billing", billingRoutes);

// Unknown routes answer JSON like everything else, never Express's HTML page.
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Not found" });
});

// Last in the chain, so `next(error)` from any handler and body-parser failures land here. The
// message and stack of an unexpected error are logged, never returned to the caller.
app.use((err, req, res, _next) => {
  if (err.type === "entity.parse.failed") {
    return res
      .status(400)
      .json({ success: false, message: "Malformed JSON body" });
  }
  if (err.type === "entity.too.large") {
    return res
      .status(413)
      .json({ success: false, message: "Request body too large" });
  }

  console.error("[Unhandled Error]:", err);
  return res
    .status(500)
    .json({ success: false, message: "Internal server error" });
});

export default app;
