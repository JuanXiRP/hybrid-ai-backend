import express from 'express';
import dotenv from 'dotenv';
import helmet from 'helmet';
import cors from 'cors';
import mongoose from 'mongoose';
import userRoutes from './routes/userRoutes.js';
import workoutRoutes from './routes/workoutRoutes.js';
import aiRoutes from './routes/aiRoutes.js';
import authRoutes from './routes/authRoutes.js';
import workoutPlanRoutes from './routes/workoutPlanRoutes.js';
import billingRoutes from './routes/billingRoutes.js';

dotenv.config();

const app = express();

app.use(helmet());
app.use(cors());

// Plan import carries a base64 PDF or photo, which blows past the 100 kb default of
// express.json(). Mounting a wider parser on that exact path BEFORE the global one is what makes
// it work: body-parser marks the request as read, so the global parser below skips it and every
// other route keeps the tight default limit. The real per-attachment caps live in aiController.
app.use('/api/ai/import-plan', express.json({ limit: '12mb' }));
app.use(express.json());

const DB_PING_TIMEOUT_MS = 2000;

const withTimeout = (promise, ms) => {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('ping timeout')), ms);
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
    if (mongoose.connection.readyState !== 1) return 'down';

    try {
        await withTimeout(mongoose.connection.db.admin().ping(), DB_PING_TIMEOUT_MS);
        return 'connected';
    } catch {
        return 'down';
    }
};

// Deliberately 200 even when the database is down: during a transient Mongoose reconnect a 503
// would make the host restart the service in a loop. Flip this to 503 only if you wire it up as a
// host health check path and actually want that restart.
app.get('/health', async (req, res) => {
    const database = await checkDatabase();

    res.status(200).json({
        status: database === 'connected' ? 'UP' : 'DEGRADED',
        environment: process.env.NODE_ENV,
        database,
        timestamp: new Date().toISOString()
    });
});

app.use('/api/users', userRoutes);
app.use('/api/workouts', workoutRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/plans', workoutPlanRoutes);
app.use('/api/billing', billingRoutes);

export default app;