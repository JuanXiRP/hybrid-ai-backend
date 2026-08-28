// src/config/db.js
import mongoose from 'mongoose';

// Same backoff shape as callWithRetry in geminiService.js — one retry idiom in this repo, not two.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_ATTEMPTS = 3;

/**
 * Translate the driver's error into the thing that is actually wrong.
 *
 * These four look alike in a deploy log but have completely different fixes, and telling them apart
 * by hand costs real time — this list is exactly the set that had to be disambiguated with a manual
 * DNS lookup when the Atlas cluster disappeared.
 */
const explainFailure = (error) => {
    const message = error?.message ?? '';

    if (message.includes('ENOTFOUND') || message.includes('querySrv')) {
        return 'the cluster hostname does not resolve — it was deleted or renamed, or MONGO_URI has a typo';
    }
    if (error?.name === 'MongoServerSelectionError' || message.includes('timed out')) {
        return 'the cluster is unreachable — check the Network Access allowlist (hosted platforms have no fixed egress IP, so they need 0.0.0.0/0)';
    }
    if (message.includes('bad auth') || message.includes('Authentication failed')) {
        return 'the database user or password inside MONGO_URI is wrong';
    }
    if (message.includes('must be a string')) {
        return 'MONGO_URI is not set';
    }
    return 'unexpected driver error';
};

// Attached once, not per attempt, so retries do not stack duplicate listeners.
let listenersRegistered = false;

/**
 * Mongoose reconnects on its own, so a blip *after* startup must not kill the process. The previous
 * behaviour — process.exit(1) on any failure — turned a transient outage into a downed service.
 */
const registerConnectionListeners = () => {
    if (listenersRegistered) return;
    listenersRegistered = true;

    mongoose.connection.on('disconnected', () => {
        console.warn('[Database] Disconnected. Mongoose will keep retrying in the background.');
    });
    mongoose.connection.on('reconnected', () => {
        console.log('[Database] Reconnected.');
    });
};

const connectDB = async (maxAttempts = MAX_ATTEMPTS) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const conn = await mongoose.connect(process.env.MONGO_URI);
            console.log(`[Database] MongoDB Connected: ${conn.connection.host}`);
            // Registered only after the first success: during the startup loop a 'disconnected'
            // event just means this attempt failed, and logging "will keep retrying in the
            // background" there would be plainly untrue.
            registerConnectionListeners();
            return conn;
        } catch (error) {
            console.error(
                `[Database] Connection attempt ${attempt}/${maxAttempts} failed: ${error.message}`
            );
            console.error(`[Database] Likely cause: ${explainFailure(error)}`);

            if (attempt === maxAttempts) {
                // A service that cannot reach its database should fail loudly rather than stay up
                // serving 500s behind a green health check.
                console.error('[Database] Giving up after all attempts. Exiting.');
                process.exit(1);
            }

            const waitTime = Math.pow(2, attempt) * 1000;
            console.warn(`[Database] Retrying in ${waitTime}ms...`);
            await delay(waitTime);
        }
    }
};

export default connectDB;
