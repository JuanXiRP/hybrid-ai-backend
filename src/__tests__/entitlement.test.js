// Free tier: 1 generated plan, 2 coach messages per UTC day, 14-day usage window, then
// read-only. Everything is derived from existing data, so these tests drive the real code
// paths (WorkoutPlan counts, ChatHistory timestamps, User.createdAt) rather than a counter.

jest.mock('../services/geminiService.js', () => ({
    generateWorkoutPlan: jest.fn().mockResolvedValue(JSON.stringify({ weeks: [] })),
    processChatMessage: jest.fn().mockResolvedValue('AI reply'),
}));

// Billing stays disabled here: no test in this file should reach the Play API, and lazy
// revalidation must short-circuit rather than throw.
jest.mock('../services/playBillingService.js', () => ({
    isBillingEnabled: jest.fn(() => false),
    getSubscription: jest.fn(),
    acknowledgeSubscription: jest.fn(),
}));

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import supertest from 'supertest';
import app from '../app.js';
import User from '../models/User.js';
import ChatHistory from '../models/ChatHistory.js';
import WorkoutPlan from '../models/WorkoutPlan.js';
import WorkoutRun from '../models/WorkoutRun.js';

let mongoServer;

const DAY_MS = 24 * 60 * 60 * 1000;

const registerAndToken = async (email = 'free@example.com') => {
    const res = await supertest(app)
        .post('/api/auth/register')
        .send({ name: 'Free User', email, password: 'password123' });
    return res.body.token;
};

const auth = (token) => ({ Authorization: `Bearer ${token}` });

const generatePlan = (token) =>
    supertest(app)
        .post('/api/ai/generate-plan')
        .set(auth(token))
        .send({ planDuration: 8, goal: 'strength' });

const sendChat = (token, message = 'hola') =>
    supertest(app).post('/api/ai/chat').set(auth(token)).send({ message });

// A payload the controller would happily accept, so that a 402 proves the middleware blocked
// the write rather than the model rejecting it (targetPace is required).
const logRun = (token) =>
    supertest(app)
        .post('/api/workouts/run')
        .set(auth(token))
        .send({ distance: 5, duration: 1800, targetPace: 330 });

/** Make the user premium the way billingController would: an active, unexpired subscription. */
const makePremium = async (email = 'free@example.com') => {
    const user = await User.findOne({ email });
    user.subscription = {
        purchaseToken: `tok-${email}`,
        productId: 'hybrid_ai_pro_monthly',
        orderId: 'GPA.1',
        expiryTime: new Date(Date.now() + 30 * DAY_MS),
        state: 'SUBSCRIPTION_STATE_ACTIVE',
        acknowledged: true,
        lastVerifiedAt: new Date(),
    };
    user.isPremium = true;
    await user.save();
};

const expireTrial = async (email = 'free@example.com') => {
    await User.updateOne({ email }, { $set: { trialEndsAt: new Date(Date.now() - DAY_MS) } });
};

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await User.syncIndexes();
});

afterEach(async () => {
    await Promise.all([
        User.deleteMany(),
        ChatHistory.deleteMany(),
        WorkoutPlan.deleteMany(),
        WorkoutRun.deleteMany(),
    ]);
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

describe('plan quota', () => {
    it('lets a free user generate their onboarding plan', async () => {
        const token = await registerAndToken();
        const res = await generatePlan(token);
        expect(res.status).toBe(201);
    });

    it('blocks the second plan with PLAN_LIMIT_REACHED', async () => {
        const token = await registerAndToken();
        expect((await generatePlan(token)).status).toBe(201);

        const res = await generatePlan(token);
        expect(res.status).toBe(402);
        expect(res.body.code).toBe('PLAN_LIMIT_REACHED');
        expect(res.body.data).toEqual({ used: 1, limit: 1 });

        expect(await WorkoutPlan.countDocuments()).toBe(1);
    });

    it('lets a premium user regenerate without limit', async () => {
        const token = await registerAndToken();
        await makePremium();

        expect((await generatePlan(token)).status).toBe(201);
        expect((await generatePlan(token)).status).toBe(201);
        expect(await WorkoutPlan.countDocuments()).toBe(2);
    });
});

describe('chat quota', () => {
    it('allows exactly two coach messages per day, then 402s', async () => {
        const token = await registerAndToken();

        expect((await sendChat(token, 'one')).status).toBe(200);
        expect((await sendChat(token, 'two')).status).toBe(200);

        const res = await sendChat(token, 'three');
        expect(res.status).toBe(402);
        expect(res.body.code).toBe('CHAT_QUOTA_EXCEEDED');
        expect(res.body.data.used).toBe(2);
        expect(res.body.data.limit).toBe(2);
        expect(new Date(res.body.data.resets_at).getTime()).toBeGreaterThan(Date.now());

        // The blocked message never reached Gemini nor the durable log.
        const history = await ChatHistory.findOne();
        expect(history.messages.filter((m) => m.role === 'user')).toHaveLength(2);
    });

    it('resets once the messages fall before the current UTC day', async () => {
        const token = await registerAndToken();
        await sendChat(token, 'one');
        await sendChat(token, 'two');
        expect((await sendChat(token, 'three')).status).toBe(402);

        // Backdate yesterday's conversation; the quota counts only today's user turns.
        const history = await ChatHistory.findOne();
        history.messages.forEach((m) => {
            m.timestamp = new Date(Date.now() - 2 * DAY_MS);
        });
        await history.save();

        expect((await sendChat(token, 'fresh day')).status).toBe(200);
    });

    it('does not limit a premium user', async () => {
        const token = await registerAndToken();
        await makePremium();

        for (const text of ['a', 'b', 'c', 'd']) {
            expect((await sendChat(token, text)).status).toBe(200);
        }
    });
});

describe('trial window', () => {
    it('blocks writes but keeps reads once the trial expires', async () => {
        const token = await registerAndToken();

        // Seed a plan while still inside the trial, and prove the run payload is otherwise
        // acceptable — otherwise the 402 below could be a validation 400 in disguise.
        expect((await generatePlan(token)).status).toBe(201);
        expect((await logRun(token)).status).toBe(201);
        await WorkoutRun.deleteMany();

        await expireTrial();

        const write = await logRun(token);
        expect(write.status).toBe(402);
        expect(write.body.code).toBe('TRIAL_EXPIRED');
        expect(await WorkoutRun.countDocuments()).toBe(0);

        const chat = await sendChat(token);
        expect(chat.status).toBe(402);
        expect(chat.body.code).toBe('TRIAL_EXPIRED');

        // Read-only: the user keeps their plan and history.
        const read = await supertest(app).get('/api/plans/active').set(auth(token));
        expect(read.status).toBe(200);

        const history = await supertest(app).get('/api/plans/history').set(auth(token));
        expect(history.status).toBe(200);
    });

    it('lifts the expiry for a premium user', async () => {
        const token = await registerAndToken();
        await expireTrial();
        await makePremium();

        expect((await logRun(token)).status).toBe(201);
        expect((await sendChat(token)).status).toBe(200);
    });

    it('still lets an expired user read their profile', async () => {
        const token = await registerAndToken();
        await expireTrial();

        const res = await supertest(app).get('/api/users/profile').set(auth(token));
        expect(res.status).toBe(200);
    });
});

describe('GET /api/billing/entitlement', () => {
    it('reports the free-tier state a client needs to render counters', async () => {
        const token = await registerAndToken();
        await sendChat(token, 'one');

        const res = await supertest(app).get('/api/billing/entitlement').set(auth(token));

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            status: 'trial',
            is_premium: false,
            plans: { used: 0, limit: 1 },
            chat: { used: 1, limit: 2 },
        });
        expect(res.body.data.trial_days_left).toBe(14);
        expect(typeof res.body.data.trial_ends_at).toBe('string');
        expect(typeof res.body.data.chat.resets_at).toBe('string');
    });

    it('reports premium with no limits', async () => {
        const token = await registerAndToken();
        await makePremium();

        const res = await supertest(app).get('/api/billing/entitlement').set(auth(token));

        expect(res.body.data.status).toBe('premium');
        expect(res.body.data.is_premium).toBe(true);
        expect(res.body.data.plans.limit).toBeNull();
        expect(res.body.data.chat.limit).toBeNull();
    });

    it('reports expired once the trial window closes', async () => {
        const token = await registerAndToken();
        await expireTrial();

        const res = await supertest(app).get('/api/billing/entitlement').set(auth(token));

        expect(res.body.data.status).toBe('expired');
        expect(res.body.data.trial_days_left).toBe(0);
    });
});
