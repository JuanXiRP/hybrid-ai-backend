// Mock the Gemini service so the chat endpoint never hits the real API.
// This lets us assert exactly what context the controller resolves and forwards.
jest.mock('../services/geminiService.js', () => ({
    processChatMessage: jest.fn().mockResolvedValue('AI reply'),
    generateWorkoutPlan: jest.fn(),
}));

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import supertest from 'supertest';
import app from '../app.js';
import User from '../models/User.js';
import ChatHistory from '../models/ChatHistory.js';
import WorkoutPlan from '../models/WorkoutPlan.js';
import { processChatMessage } from '../services/geminiService.js';

let mongoServer;

const registerAndToken = async (email = 'coach@example.com') => {
    const res = await supertest(app)
        .post('/api/auth/register')
        .send({ name: 'Coach User', email, password: 'password123' });
    return res.body.token;
};

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
    processChatMessage.mockClear();
    await User.deleteMany();
    await ChatHistory.deleteMany();
    await WorkoutPlan.deleteMany();
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

describe('POST /api/ai/chat', () => {
    it('rejects a request with no message', async () => {
        const token = await registerAndToken();
        const res = await supertest(app)
            .post('/api/ai/chat')
            .set('Authorization', `Bearer ${token}`)
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('works with only a message (backward compatible) and persists the turn', async () => {
        const token = await registerAndToken();
        const res = await supertest(app)
            .post('/api/ai/chat')
            .set('Authorization', `Bearer ${token}`)
            .send({ message: 'hola' });

        expect(res.status).toBe(200);
        expect(res.body.data.reply).toBe('AI reply');

        // No plan and no prior history yet -> empty context forwarded to Gemini.
        const [conversation, message, planContext] = processChatMessage.mock.calls[0];
        expect(conversation).toEqual([]);
        expect(message).toBe('hola');
        expect(planContext).toBe('');

        // The exchange is persisted to the durable log.
        const stored = await ChatHistory.findOne();
        expect(stored.messages.map((m) => m.role)).toEqual(['user', 'model']);
        expect(stored.messages[1].content).toBe('AI reply');
    });

    it('injects client-sent plan_context and history into the Gemini call', async () => {
        const token = await registerAndToken();
        const res = await supertest(app)
            .post('/api/ai/chat')
            .set('Authorization', `Bearer ${token}`)
            .send({
                message: '¿por qué tanto RPE el día 1?',
                plan_context: 'Goal: both, Duration: 8 weeks. Day 1 Squats RPE 7',
                history: [
                    { role: 'user', content: 'Hola' },
                    { role: 'model', content: '¡Hola! ¿En qué te ayudo?' },
                ],
            });

        expect(res.status).toBe(200);

        const [conversation, message, planContext] = processChatMessage.mock.calls[0];
        expect(conversation).toEqual([
            { role: 'user', content: 'Hola' },
            { role: 'model', content: '¡Hola! ¿En qué te ayudo?' },
        ]);
        expect(message).toBe('¿por qué tanto RPE el día 1?');
        expect(planContext).toContain('Squats RPE 7');
    });

    it('prefers client plan_context over the persisted plan', async () => {
        const token = await registerAndToken();
        const user = await User.findOne();
        await WorkoutPlan.create({
            userId: user._id,
            durationWeeks: 8,
            goal: 'strength',
            weeks: [],
        });

        await supertest(app)
            .post('/api/ai/chat')
            .set('Authorization', `Bearer ${token}`)
            .send({ message: 'q', plan_context: 'CLIENT SUMMARY' });

        const planContext = processChatMessage.mock.calls[0][2];
        expect(planContext).toBe('CLIENT SUMMARY');
    });

    it('tolerates a non-array history and filters invalid turns', async () => {
        const token = await registerAndToken();

        // Non-array history -> treated as empty, falls back to (empty) DB log.
        const res1 = await supertest(app)
            .post('/api/ai/chat')
            .set('Authorization', `Bearer ${token}`)
            .send({ message: 'a', history: 'not-an-array' });
        expect(res1.status).toBe(200);
        expect(processChatMessage.mock.calls[0][0]).toEqual([]);

        processChatMessage.mockClear();

        // Invalid roles / empty content are filtered out.
        const res2 = await supertest(app)
            .post('/api/ai/chat')
            .set('Authorization', `Bearer ${token}`)
            .send({
                message: 'b',
                history: [
                    { role: 'system', content: 'nope' },
                    { role: 'user', content: 'hi' },
                    { role: 'model', content: 'ok' },
                    { role: 'user', content: '' },
                ],
            });
        expect(res2.status).toBe(200);
        expect(processChatMessage.mock.calls[0][0]).toEqual([
            { role: 'user', content: 'hi' },
            { role: 'model', content: 'ok' },
        ]);
    });
});
