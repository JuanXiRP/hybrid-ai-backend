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

import {
    generateWorkoutPlan,
    importAndCompleteWorkoutPlan,
    processChatMessage,
} from '../services/geminiService.js';

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

describe('importAndCompleteWorkoutPlan — contents and prompt', () => {
    const profile = {
        planDuration: 8,
        goal: 'both',
        fitnessLevel: 'intermediate',
        daysAvailable: 5,
        weight: 78,
        sex: 'male',
        injuries: ['left knee'],
    };

    it('sends the attachments as inlineData parts before the instruction text', async () => {
        await importAndCompleteWorkoutPlan(profile, {
            providedDomain: 'strength',
            planDuration: 8,
            sourceText: '',
            attachments: [
                { mimeType: 'application/pdf', data: 'JVBERi0xLjQK' },
                { mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' },
            ],
        });

        const contents = mockGenerateContent.mock.calls[0][0];
        expect(Array.isArray(contents)).toBe(true);
        expect(contents).toHaveLength(3);
        expect(contents[0]).toEqual({
            inlineData: { mimeType: 'application/pdf', data: 'JVBERi0xLjQK' },
        });
        expect(contents[1]).toEqual({
            inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' },
        });
        expect(typeof contents[2].text).toBe('string');
        expect(contents[2].text).toContain('2 document(s)/image(s)');
    });

    it('asks the model to reproduce the strength half and author only the cardio half', async () => {
        await importAndCompleteWorkoutPlan(profile, {
            providedDomain: 'strength',
            planDuration: 8,
            sourceText: 'Day A: Squat 5x5 @RPE8',
            attachments: [],
        });

        const contents = mockGenerateContent.mock.calls[0][0];
        const prompt = contents.at(-1).text;

        expect(prompt).toContain('Squat 5x5 @RPE8');
        expect(prompt).toMatch(/FIDELITY/);
        // The imported half keeps the domain the athlete supplied...
        expect(prompt).toContain("workoutType 'strength'");
        expect(prompt).toContain("source 'imported'");
        // ...and the model is told to write the other one, and only that one.
        expect(prompt).toContain('You author ONLY the cardio half');
        expect(prompt).toContain("Never write a 'strength' day of your own");
        expect(prompt).toContain('exactly 8 weeks');
        expect(prompt).toContain('must not exceed 5');
        expect(prompt).toContain('left knee');
        // Without attachments there is nothing to announce.
        expect(prompt).not.toContain('document(s)/image(s)');
    });

    it('flips the roles when the athlete supplies their running block instead', async () => {
        await importAndCompleteWorkoutPlan(
            { ...profile, sex: 'female', last_period_date: '2026-07-01' },
            {
                providedDomain: 'cardio',
                planDuration: 12,
                sourceText: 'Tue: 8km easy',
                attachments: [],
            },
        );

        const prompt = mockGenerateContent.mock.calls[0][0].at(-1).text;

        expect(prompt).toContain("workoutType 'cardio'");
        expect(prompt).toContain('You author ONLY the strength half');
        expect(prompt).toContain("Never write a 'cardio' day of your own");
        // The cycle-aware block is shared with the generation path.
        expect(prompt).toMatch(/MENSTRUAL CYCLE AWARENESS/i);
        expect(prompt).toContain('2026-07-01');
    });

    it('requests the source-carrying response schema', async () => {
        await importAndCompleteWorkoutPlan(profile, {
            providedDomain: 'strength',
            planDuration: 4,
            sourceText: 'anything',
            attachments: [],
        });

        const modelConfig = mockGetGenerativeModel.mock.calls.at(-1)[0];
        const daySchema =
            modelConfig.generationConfig.responseSchema.properties.weeks.items.properties.days.items;

        expect(daySchema.properties.source).toBeDefined();
        expect(daySchema.required).toContain('source');
    });

    it('leaves the generation schema untouched (no source field)', async () => {
        await generateWorkoutPlan(profile);

        const modelConfig = mockGetGenerativeModel.mock.calls.at(-1)[0];
        const daySchema =
            modelConfig.generationConfig.responseSchema.properties.weeks.items.properties.days.items;

        expect(daySchema.properties.source).toBeUndefined();
        expect(daySchema.required).not.toContain('source');
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
