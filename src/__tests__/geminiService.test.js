// Capture what is handed to Gemini without hitting the real API.
// Jest only allows the mock factory to reference variables prefixed with "mock".
const mockGenerateContent = jest.fn().mockResolvedValue({
    response: { text: () => JSON.stringify({ durationWeeks: 8, goal: 'both', weeks: [] }) },
});
const mockSendMessage = jest.fn().mockResolvedValue({
    response: { text: () => 'coach reply' },
});
const mockStartChat = jest.fn(() => ({ sendMessage: mockSendMessage }));
const mockGetGenerativeModel = jest.fn(() => ({
    generateContent: mockGenerateContent,
    startChat: mockStartChat,
}));

jest.mock('@google/generative-ai', () => ({
    // SchemaType is read at module load when building workoutPlanSchema; a proxy that
    // returns the property name for any key is enough to let the module initialize.
    SchemaType: new Proxy({}, { get: (_target, prop) => String(prop) }),
    GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
        // Wrapped in an arrow so the mock is referenced lazily (at call time), avoiding a TDZ
        // error: babel hoists the service import above these const declarations.
        getGenerativeModel: (...args) => mockGetGenerativeModel(...args),
    })),
}));

import { generateWorkoutPlan, processChatMessage } from '../services/geminiService.js';

afterEach(() => {
    mockGenerateContent.mockClear();
    mockSendMessage.mockClear();
    mockStartChat.mockClear();
    mockGetGenerativeModel.mockClear();
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

describe('processChatMessage — context injection', () => {
    it('injects plan context into the system instruction and maps history to contents', async () => {
        const reply = await processChatMessage(
            [
                { role: 'user', content: 'Hola' },
                { role: 'model', content: '¡Hola! ¿En qué te ayudo?' },
            ],
            '¿por qué tanto RPE el día 1?',
            'Goal: both, Duration: 8 weeks. Week 1 Day 1 - Squats RPE 7',
        );

        expect(reply).toBe('coach reply');

        const modelConfig = mockGetGenerativeModel.mock.calls.at(-1)[0];
        expect(modelConfig.systemInstruction).toContain('current training plan');
        expect(modelConfig.systemInstruction).toContain('Squats RPE 7');

        const startChatArg = mockStartChat.mock.calls.at(-1)[0];
        expect(startChatArg.history).toEqual([
            { role: 'user', parts: [{ text: 'Hola' }] },
            { role: 'model', parts: [{ text: '¡Hola! ¿En qué te ayudo?' }] },
        ]);
        expect(mockSendMessage).toHaveBeenCalledWith('¿por qué tanto RPE el día 1?');
    });

    it('omits the plan block from the system instruction when no plan context is given', async () => {
        await processChatMessage([], 'hola', '');

        const modelConfig = mockGetGenerativeModel.mock.calls.at(-1)[0];
        expect(modelConfig.systemInstruction).not.toContain('current training plan');
        expect(mockStartChat.mock.calls.at(-1)[0].history).toEqual([]);
    });
});
