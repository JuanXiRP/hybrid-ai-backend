import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import supertest from 'supertest';
import app from '../app.js';
import User from '../models/User.js';

let mongoServer;

const fullProfile = {
    age: 30,
    weight: 60,
    height: 165,
    sex: 'female',
    goal: 'both',
    fitnessLevel: 'intermediate',
    daysAvailable: 4,
    planDuration: 8,
};

async function registerAndToken(email = 'ada@example.com') {
    const res = await supertest(app)
        .post('/api/auth/register')
        .send({ name: 'Ada', email, password: 'password123' });
    return res.body.token;
}

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
    await User.deleteMany();
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

describe('PATCH /api/users/profile — last_period_date', () => {
    it('persists a valid last_period_date and returns it in snake_case', async () => {
        const token = await registerAndToken();

        const res = await supertest(app)
            .patch('/api/users/profile')
            .set('Authorization', `Bearer ${token}`)
            .send({ ...fullProfile, last_period_date: '2026-07-01' });

        expect(res.status).toBe(200);
        expect(res.body.data.last_period_date).toBe('2026-07-01');

        // Round-trips through GET without format drift
        const getRes = await supertest(app)
            .get('/api/users/profile')
            .set('Authorization', `Bearer ${token}`);
        expect(getRes.body.data.last_period_date).toBe('2026-07-01');
    });

    it('accepts a profile update without last_period_date (stays null)', async () => {
        const token = await registerAndToken();

        const res = await supertest(app)
            .patch('/api/users/profile')
            .set('Authorization', `Bearer ${token}`)
            .send({ ...fullProfile });

        expect(res.status).toBe(200);
        expect(res.body.data.last_period_date ?? null).toBeNull();
    });

    it('rejects a future last_period_date', async () => {
        const token = await registerAndToken();

        const res = await supertest(app)
            .patch('/api/users/profile')
            .set('Authorization', `Bearer ${token}`)
            .send({ ...fullProfile, last_period_date: '2999-01-01' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('rejects a malformed last_period_date', async () => {
        const token = await registerAndToken();

        const res = await supertest(app)
            .patch('/api/users/profile')
            .set('Authorization', `Bearer ${token}`)
            .send({ ...fullProfile, last_period_date: '01/07/2026' });

        expect(res.status).toBe(400);
    });

    it('rejects an impossible calendar date', async () => {
        const token = await registerAndToken();

        const res = await supertest(app)
            .patch('/api/users/profile')
            .set('Authorization', `Bearer ${token}`)
            .send({ ...fullProfile, last_period_date: '2026-02-30' });

        expect(res.status).toBe(400);
    });
});

// Entitlement fields (isPremium, trialEndsAt, subscription) are owned exclusively by
// billingController. Both write paths into User used to spread req.body, which made every
// one of those fields client-writable — a trivial privilege escalation once premium gates
// anything. These tests pin the allowlists shut.
describe('mass assignment — entitlement fields are not client-writable', () => {
    it('ignores isPremium in PATCH /api/users/profile', async () => {
        const token = await registerAndToken();

        const res = await supertest(app)
            .patch('/api/users/profile')
            .set('Authorization', `Bearer ${token}`)
            .send({ ...fullProfile, isPremium: true });

        expect(res.status).toBe(200);
        expect(res.body.data.isPremium).toBe(false);

        // The database, not just the response body, must be unchanged.
        const user = await User.findOne({ email: 'ada@example.com' });
        expect(user.isPremium).toBe(false);
    });

    it('ignores trialEndsAt and subscription in PATCH /api/users/profile', async () => {
        const token = await registerAndToken();
        const farFuture = '2999-01-01T00:00:00.000Z';

        await supertest(app)
            .patch('/api/users/profile')
            .set('Authorization', `Bearer ${token}`)
            .send({
                ...fullProfile,
                trialEndsAt: farFuture,
                subscription: { purchaseToken: 'forged', state: 'SUBSCRIPTION_STATE_ACTIVE' },
            });

        const user = await User.findOne({ email: 'ada@example.com' });
        expect(user.trialEndsAt ?? null).toBeNull();
        expect(user.subscription?.purchaseToken ?? null).toBeNull();
    });

    it('ignores isPremium in POST /api/users', async () => {
        const res = await supertest(app)
            .post('/api/users')
            .send({
                name: 'Grace',
                email: 'grace@example.com',
                password: 'password123',
                isPremium: true,
            });

        expect(res.status).toBe(201);

        const user = await User.findOne({ email: 'grace@example.com' });
        expect(user.isPremium).toBe(false);
    });

    it('still persists the legitimate onboarding fields', async () => {
        const token = await registerAndToken();

        const res = await supertest(app)
            .patch('/api/users/profile')
            .set('Authorization', `Bearer ${token}`)
            .send({ ...fullProfile, isPremium: true });

        expect(res.body.data.age).toBe(30);
        expect(res.body.data.goal).toBe('both');
        expect(res.body.data.planDuration).toBe(8);
        expect(res.body.data.hasCompletedOnboarding).toBe(true);
    });
});
