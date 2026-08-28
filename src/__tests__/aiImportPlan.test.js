// Mock the Gemini service so the import endpoint never hits the real API. The controller's job
// here is payload validation, profile resolution and persistence — the prompt itself is covered
// by geminiService.test.js.
jest.mock('../services/geminiService.js', () => ({
    importAndCompleteWorkoutPlan: jest.fn(),
    generateWorkoutPlan: jest.fn(),
    processChatMessage: jest.fn(),
}));

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import supertest from 'supertest';
import app from '../app.js';
import User from '../models/User.js';
import WorkoutPlan from '../models/WorkoutPlan.js';
import { importAndCompleteWorkoutPlan } from '../services/geminiService.js';

let mongoServer;

// A minimal merged macrocycle: one imported gym day, one generated run, one rest day.
const MERGED_PLAN = {
    durationWeeks: 4,
    goal: 'both',
    weeks: [
        {
            weekNumber: 1,
            days: [
                {
                    dayName: 'Lower Body',
                    workoutType: 'strength',
                    source: 'imported',
                    exercises: [{ name: 'Back Squat', sets: '5', reps: '5', rpe: '8' }],
                },
                {
                    dayName: 'Zone 2 Run',
                    workoutType: 'cardio',
                    source: 'generated',
                    exercises: [{ name: 'Easy run', sets: '1', reps: '8 km', rpe: '4' }],
                },
                { dayName: 'Rest', workoutType: 'rest', source: 'generated', exercises: [] },
            ],
        },
    ],
};

const registerAndToken = async (email = 'importer@example.com') => {
    const res = await supertest(app)
        .post('/api/auth/register')
        .send({ name: 'Import User', email, password: 'password123' });
    return res.body.token;
};

const post = (token, body) =>
    supertest(app)
        .post('/api/ai/import-plan')
        .set('Authorization', `Bearer ${token}`)
        .send(body);

// A tiny but syntactically valid base64 PDF header.
const PDF_BASE64 = 'JVBERi0xLjQK';

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
});

beforeEach(() => {
    importAndCompleteWorkoutPlan.mockResolvedValue(JSON.stringify(MERGED_PLAN));
});

afterEach(async () => {
    importAndCompleteWorkoutPlan.mockReset();
    await User.deleteMany();
    await WorkoutPlan.deleteMany();
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

describe('POST /api/ai/import-plan — payload validation', () => {
    it('requires authentication', async () => {
        const res = await supertest(app)
            .post('/api/ai/import-plan')
            .send({ providedDomain: 'strength', sourceText: 'x' });

        expect(res.status).toBe(401);
    });

    it('rejects a missing or unknown providedDomain', async () => {
        const token = await registerAndToken();

        const missing = await post(token, { sourceText: 'Squat 5x5' });
        expect(missing.status).toBe(400);
        expect(missing.body.message).toMatch(/providedDomain/);

        const unknown = await post(token, { providedDomain: 'yoga', sourceText: 'Squat 5x5' });
        expect(unknown.status).toBe(400);

        expect(importAndCompleteWorkoutPlan).not.toHaveBeenCalled();
    });

    it('rejects a request with neither text nor attachments', async () => {
        const token = await registerAndToken();

        const res = await post(token, { providedDomain: 'strength', sourceText: '   ' });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/sourceText|attachment/i);
        expect(importAndCompleteWorkoutPlan).not.toHaveBeenCalled();
    });

    it('rejects an attachment whose mime type is not allowed', async () => {
        const token = await registerAndToken();

        const res = await post(token, {
            providedDomain: 'strength',
            attachments: [{ mimeType: 'application/zip', data: PDF_BASE64 }],
        });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Unsupported attachment type/);
        expect(importAndCompleteWorkoutPlan).not.toHaveBeenCalled();
    });

    it('rejects attachment data that is not base64', async () => {
        const token = await registerAndToken();

        const res = await post(token, {
            providedDomain: 'strength',
            attachments: [{ mimeType: 'application/pdf', data: 'not base64!!' }],
        });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/base64/);
    });

    it('rejects more than five attachments', async () => {
        const token = await registerAndToken();

        const res = await post(token, {
            providedDomain: 'cardio',
            attachments: Array.from({ length: 6 }, () => ({
                mimeType: 'image/png',
                data: PDF_BASE64,
            })),
        });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/At most 5 attachments/);
    });
});

describe('POST /api/ai/import-plan — happy path', () => {
    it('forwards the source material and persists the merged plan', async () => {
        const token = await registerAndToken();

        const res = await post(token, {
            providedDomain: 'strength',
            planDuration: 4,
            goal: 'both',
            sourceText: 'Day A: Back Squat 5x5 @RPE8',
            attachments: [{ mimeType: 'application/pdf', data: PDF_BASE64 }],
        });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);

        // The service receives the material as explicit arguments, not smuggled in the profile.
        const [userProfile, options] = importAndCompleteWorkoutPlan.mock.calls[0];
        expect(options.providedDomain).toBe('strength');
        expect(options.planDuration).toBe(4);
        expect(options.sourceText).toBe('Day A: Back Squat 5x5 @RPE8');
        expect(options.attachments).toHaveLength(1);
        expect(userProfile.sourceText).toBeUndefined();
        expect(userProfile.attachments).toBeUndefined();
        expect(userProfile.email).toBe('importer@example.com');

        const stored = await WorkoutPlan.findOne();
        expect(stored.origin).toBe('imported');
        expect(stored.durationWeeks).toBe(4);
        const days = stored.weeks[0].days;
        expect(days.map((d) => d.source)).toEqual(['imported', 'generated', 'generated']);
        expect(days[0].workoutType).toBe('strength');
        expect(days[1].workoutType).toBe('cardio');
    });

    it('falls back to the persisted profile for planDuration and goal', async () => {
        const token = await registerAndToken();
        await User.updateOne({}, { planDuration: 12, goal: 'endurance' });

        await post(token, { providedDomain: 'cardio', sourceText: 'Tue: 8km easy' });

        expect(importAndCompleteWorkoutPlan.mock.calls[0][1].planDuration).toBe(12);

        const stored = await WorkoutPlan.findOne();
        expect(stored.durationWeeks).toBe(12);
        expect(stored.goal).toBe('endurance');
    });

    it('defaults source to "generated" when the model omits it', async () => {
        const token = await registerAndToken();
        importAndCompleteWorkoutPlan.mockResolvedValue(
            JSON.stringify({
                weeks: [
                    {
                        weekNumber: 1,
                        days: [{ dayName: 'Run', workoutType: 'cardio', exercises: [] }],
                    },
                ],
            }),
        );

        const res = await post(token, {
            providedDomain: 'strength',
            planDuration: 4,
            goal: 'both',
            sourceText: 'Squat 5x5',
        });

        expect(res.status).toBe(201);
        const stored = await WorkoutPlan.findOne();
        expect(stored.weeks[0].days[0].source).toBe('generated');
    });
});

describe('POST /api/ai/import-plan — failure modes', () => {
    it('returns 422 when the model finds no plan in the material', async () => {
        const token = await registerAndToken();
        importAndCompleteWorkoutPlan.mockResolvedValue(
            JSON.stringify({ durationWeeks: 4, goal: 'both', weeks: [] }),
        );

        const res = await post(token, {
            providedDomain: 'strength',
            planDuration: 4,
            sourceText: 'shopping list: milk, eggs',
        });

        expect(res.status).toBe(422);
        expect(res.body.success).toBe(false);
        expect(await WorkoutPlan.countDocuments()).toBe(0);
    });

    it('returns 500 when the AI call fails', async () => {
        const token = await registerAndToken();
        importAndCompleteWorkoutPlan.mockRejectedValue(new Error('Gemini exploded'));

        const res = await post(token, { providedDomain: 'strength', sourceText: 'Squat 5x5' });

        expect(res.status).toBe(500);
        expect(await WorkoutPlan.countDocuments()).toBe(0);
    });

    it('consumes the same free-plan quota as generation', async () => {
        const token = await registerAndToken();
        const user = await User.findOne();
        await WorkoutPlan.create({
            userId: user._id,
            durationWeeks: 8,
            goal: 'both',
            weeks: [],
        });

        const res = await post(token, { providedDomain: 'strength', sourceText: 'Squat 5x5' });

        expect(res.status).toBe(402);
        expect(res.body.code).toBe('PLAN_LIMIT_REACHED');
        expect(importAndCompleteWorkoutPlan).not.toHaveBeenCalled();
    });
});

describe('POST /api/ai/import-plan — body size', () => {
    it('accepts a payload far larger than the 100 kb global express.json limit', async () => {
        const token = await registerAndToken();
        // ~600 kB of base64: rejected by the default parser, fine for this route's 12 MB one.
        const bigButLegal = 'A'.repeat(600 * 1024);

        const res = await post(token, {
            providedDomain: 'strength',
            planDuration: 4,
            goal: 'both',
            attachments: [{ mimeType: 'application/pdf', data: bigButLegal }],
        });

        expect(res.status).toBe(201);
    });

    it('still enforces the tight limit on other routes', async () => {
        const token = await registerAndToken();

        const res = await supertest(app)
            .post('/api/ai/chat')
            .set('Authorization', `Bearer ${token}`)
            .send({ message: 'x'.repeat(200 * 1024) });

        expect(res.status).toBe(413);
    });
});
