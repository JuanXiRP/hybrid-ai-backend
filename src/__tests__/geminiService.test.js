// Capture the prompt handed to Gemini without hitting the real API.
// Jest only allows the mock factory to reference variables prefixed with "mock".
const mockGenerateContent = jest.fn().mockResolvedValue({
    response: { text: () => JSON.stringify({ durationWeeks: 8, goal: 'both', weeks: [] }) },
});

jest.mock('@google/generative-ai', () => ({
    // SchemaType is read at module load when building workoutPlanSchema; a proxy that
    // returns the property name for any key is enough to let the module initialize.
    SchemaType: new Proxy({}, { get: (_target, prop) => String(prop) }),
    GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
        getGenerativeModel: () => ({ generateContent: mockGenerateContent }),
    })),
}));

import { generateWorkoutPlan } from '../services/geminiService.js';

afterEach(() => {
    mockGenerateContent.mockClear();
});

describe('generateWorkoutPlan — prompt content', () => {
    it('includes injuries and the cycle-aware block for a female with last_period_date', async () => {
        await generateWorkoutPlan({
            planDuration: 8,
            goal: 'both',
            fitnessLevel: 'intermediate',
            daysAvailable: 4,
            weight: 60,
            sex: 'female',
            injuries: ['left knee', 'lower back'],
            last_period_date: '2026-07-01',
        });

        const prompt = mockGenerateContent.mock.calls[0][0];
        expect(prompt).toContain('left knee');
        expect(prompt).toContain('lower back');
        expect(prompt).toContain('2026-07-01');
        expect(prompt).toMatch(/MENSTRUAL CYCLE AWARENESS/i);
    });

    it('omits the cycle block for male users and shows "None reported" when no injuries', async () => {
        await generateWorkoutPlan({
            planDuration: 8,
            goal: 'strength',
            fitnessLevel: 'beginner',
            daysAvailable: 3,
            weight: 80,
            sex: 'male',
            injuries: [],
        });

        const prompt = mockGenerateContent.mock.calls[0][0];
        expect(prompt).not.toMatch(/MENSTRUAL CYCLE AWARENESS/i);
        expect(prompt).toContain('None reported');
    });

    it('does not emit the cycle block for a female missing last_period_date', async () => {
        await generateWorkoutPlan({
            planDuration: 4,
            goal: 'endurance',
            fitnessLevel: 'advanced',
            daysAvailable: 5,
            weight: 55,
            sex: 'female',
            injuries: ['shoulder'],
        });

        const prompt = mockGenerateContent.mock.calls[0][0];
        expect(prompt).not.toMatch(/MENSTRUAL CYCLE AWARENESS/i);
        expect(prompt).toContain('shoulder');
    });
});
