jest.mock('google-auth-library', () => ({
    OAuth2Client: jest.fn().mockImplementation(() => ({
        verifyIdToken: jest.fn().mockResolvedValue({
            getPayload: () => ({
                sub: 'google-123',
                email: 'googleuser@gmail.com',
                name: 'Google User'
            })
        })
    }))
}));

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import supertest from 'supertest';
import app from '../app.js';
import User from '../models/User.js';
import WorkoutPlan from '../models/WorkoutPlan.js';

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
    await User.deleteMany();
    await WorkoutPlan.deleteMany();
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

// ==================== REGISTER ====================
describe('POST /api/auth/register', () => {
    it('registers a new user and returns a token', async () => {
        const res = await supertest(app)
            .post('/api/auth/register')
            .send({ name: 'Test', email: 'test@example.com', password: 'password123' });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.token).toBeDefined();
    });

    it('rejects duplicate email', async () => {
        await supertest(app)
            .post('/api/auth/register')
            .send({ name: 'First', email: 'test@example.com', password: 'password123' });

        const res = await supertest(app)
            .post('/api/auth/register')
            .send({ name: 'Second', email: 'test@example.com', password: 'password123' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });
});

// ==================== LOGIN + ONBOARDING FLAG ====================
describe('POST /api/auth/login', () => {
    beforeEach(async () => {
        await supertest(app)
            .post('/api/auth/register')
            .send({ name: 'Test', email: 'test@example.com', password: 'password123' });
    });

    it('returns has_completed_onboarding: false when user has NO plan', async () => {
        const res = await supertest(app)
            .post('/api/auth/login')
            .send({ email: 'test@example.com', password: 'password123' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.token).toBeDefined();
        expect(res.body.has_completed_onboarding).toBe(false);
    });

    it('returns has_completed_onboarding: true when user HAS a plan', async () => {
        const user = await User.findOne({ email: 'test@example.com' });
        await WorkoutPlan.create({
            userId: user._id,
            durationWeeks: 8,
            goal: 'strength',
            weeks: []
        });

        const res = await supertest(app)
            .post('/api/auth/login')
            .send({ email: 'test@example.com', password: 'password123' });

        expect(res.status).toBe(200);
        expect(res.body.has_completed_onboarding).toBe(true);
    });

    it('rejects wrong password', async () => {
        const res = await supertest(app)
            .post('/api/auth/login')
            .send({ email: 'test@example.com', password: 'wrongpassword' });

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });
});

// ==================== GOOGLE SIGN-IN ====================
describe('POST /api/auth/google', () => {
    it('creates a new user via Google and returns token', async () => {
        const res = await supertest(app)
            .post('/api/auth/google')
            .send({ idToken: 'fake-google-token' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.token).toBeDefined();
        expect(res.body.has_completed_onboarding).toBe(false);
    });

    it('returns has_completed_onboarding: true when Google user has a plan', async () => {
        await supertest(app)
            .post('/api/auth/google')
            .send({ idToken: 'fake-google-token' });

        const user = await User.findOne({ email: 'googleuser@gmail.com' });
        await WorkoutPlan.create({
            userId: user._id,
            durationWeeks: 8,
            goal: 'strength',
            weeks: []
        });

        const res = await supertest(app)
            .post('/api/auth/google')
            .send({ idToken: 'fake-google-token' });

        expect(res.status).toBe(200);
        expect(res.body.has_completed_onboarding).toBe(true);
    });

    it('links Google to existing email/password user without duplicating', async () => {
        await supertest(app)
            .post('/api/auth/register')
            .send({ name: 'Google User', email: 'googleuser@gmail.com', password: 'password123' });

        const res = await supertest(app)
            .post('/api/auth/google')
            .send({ idToken: 'fake-google-token' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const users = await User.find({ email: 'googleuser@gmail.com' });
        expect(users).toHaveLength(1);
        expect(users[0].googleId).toBe('google-123');
    });
});