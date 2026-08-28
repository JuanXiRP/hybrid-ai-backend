import express from 'express';
import dotenv from 'dotenv';
import helmet from 'helmet';
import cors from 'cors';
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

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'UP',
        environment: process.env.NODE_ENV,
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