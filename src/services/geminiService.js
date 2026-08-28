// src/services/geminiService.js
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MODEL_ID = 'gemini-2.5-flash-lite';

// Helper function to pause execution for retry logic
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 🟢 1. Schema builder: 'workoutType' strictly segregates UI rendering states. 'source' is only
// requested on the import path, where the model has to tell us which days it copied from the
// athlete's own program and which ones it wrote itself. The generation path leaves it out so
// Mongoose's default ('generated') applies.
const buildWorkoutPlanSchema = ({ withSource = false } = {}) => {
    const dayProperties = {
        dayName: {
            type: SchemaType.STRING,
            description: "Name of the day or session focus, e.g., 'Lower Body', 'Zone 2 Run', 'Rest'"
        },
        workoutType: {
            type: SchemaType.STRING,
            description: "MUST be exactly one of: 'strength', 'cardio', or 'rest'. This controls the app UI."
        },
        exercises: {
            type: SchemaType.ARRAY,
            description: "List of exercises. Must be empty for 'rest' days. For 'cardio', optionally add a single object detailing the run parameters.",
            items: {
                type: SchemaType.OBJECT,
                properties: {
                    name: { type: SchemaType.STRING },
                    sets: { type: SchemaType.STRING },
                    reps: { type: SchemaType.STRING },
                    rpe: { type: SchemaType.STRING }
                },
                required: ["name", "sets", "reps", "rpe"]
            }
        }
    };

    const dayRequired = ["dayName", "workoutType", "exercises"]; // 🟢 Enforces the backend flag

    if (withSource) {
        dayProperties.source = {
            type: SchemaType.STRING,
            description: "MUST be exactly one of: 'imported' (this session was taken from the training program the athlete supplied) or 'generated' (you wrote this session yourself)."
        };
        dayRequired.push("source");
    }

    return {
        type: SchemaType.OBJECT,
        properties: {
            durationWeeks: {
                type: SchemaType.INTEGER,
                description: "Total number of weeks for the macrocycle"
            },
            goal: {
                type: SchemaType.STRING,
                description: "Primary fitness goal of the macrocycle"
            },
            weeks: {
                type: SchemaType.ARRAY,
                description: "Array containing each week's programming",
                items: {
                    type: SchemaType.OBJECT,
                    properties: {
                        weekNumber: {
                            type: SchemaType.INTEGER,
                            description: "The sequential week number, e.g., 1, 2, 3"
                        },
                        days: {
                            type: SchemaType.ARRAY,
                            description: "The specific training days in this week",
                            items: {
                                type: SchemaType.OBJECT,
                                properties: dayProperties,
                                required: dayRequired
                            }
                        }
                    },
                    required: ["weekNumber", "days"]
                }
            }
        },
        required: ["durationWeeks", "goal", "weeks"]
    };
};

const workoutPlanSchema = buildWorkoutPlanSchema();
const importedWorkoutPlanSchema = buildWorkoutPlanSchema({ withSource: true });

// 🟢 Injuries: always surfaced so the model can regress/avoid contraindicated movements.
const formatInjuries = (userProfile) =>
    Array.isArray(userProfile.injuries) && userProfile.injuries.length > 0
        ? userProfile.injuries.join(', ')
        : 'None reported';

// 🟢 Cycle-aware block: only for female athletes with a known last period date.
const buildCycleAwareBlock = (userProfile) => {
    const isFemaleWithCycle = userProfile.sex === 'female' && userProfile.last_period_date;
    if (!isFemaleWithCycle) return '';

    return `

        MENSTRUAL CYCLE AWARENESS (female athlete):
        - Last menstrual period start date: ${userProfile.last_period_date} (ISO yyyy-MM-dd).
        - Today's date: ${new Date().toISOString().slice(0, 10)} (ISO yyyy-MM-dd).
        - Estimate the current cycle phase from these two dates (assume a ~28-day cycle) and modulate training LOAD (intensity/volume) accordingly — never remove training days, only adjust their demand:
          * Menstrual / early follicular: keep intensity moderate; prioritize technique, mobility and recovery.
          * Late follicular / ovulation: schedule the highest-intensity strength and interval sessions (peak performance window).
          * Luteal: progressively reduce peak intensity, favor aerobic/volume work, and add a deload toward the late luteal phase.
        - Keep this modulation consistent with the progressive overload of the macrocycle.`;
};

// Shared call site for both plan flows. `contents` is whatever the SDK accepts: a plain prompt
// string for text-only generation, or an array of Parts when we also send the athlete's PDF/photos.
const callWithRetry = async (model, contents, maxRetries) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await model.generateContent(contents);
            const response = await result.response;
            return response.text();
        } catch (error) {
            const isRateLimitOrUnavailable = error.status === 503 || error.status === 429;

            if (isRateLimitOrUnavailable && attempt < maxRetries) {
                const waitTime = Math.pow(2, attempt) * 1000;
                console.warn(`[Gemini API] Server busy. Retrying attempt ${attempt} in ${waitTime}ms...`);
                await delay(waitTime);
            } else {
                console.error("[Gemini API Error]:", error);
                throw new Error("Failed to connect to Gemini AI after multiple attempts");
            }
        }
    }
};

// @desc    Generate a tailored workout plan using Gemini AI with retry logic
export const generateWorkoutPlan = async (userProfile, maxRetries = 3) => {
    const model = genAI.getGenerativeModel({
        model: MODEL_ID,
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: workoutPlanSchema
        }
    });

    const injuriesList = formatInjuries(userProfile);
    const cycleAwareBlock = buildCycleAwareBlock(userProfile);

    // 🟢 2. Strict Prompt Engineering: Boundary enforcement for hybrid isolation
    const prompt = `
        Act as an elite Hybrid Training coach. Create a progressive ${userProfile.planDuration}-week macrocycle.
        Profile:
        - Goal: ${userProfile.goal}
        - Experience: ${userProfile.fitnessLevel}
        - Availability: ${userProfile.daysAvailable} days/week
        - Weight: ${userProfile.weight}kg
        - Sex: ${userProfile.sex}
        - Injuries / limitations: ${injuriesList}

        CRITICAL ARCHITECTURE RULES:
        1. DOMAIN ISOLATION: DO NOT mix strength (gym) and cardio (running/cycling) in the same session.
        2. A session MUST be classified strictly via 'workoutType' as 100% 'strength', 100% 'cardio', or 'rest'.
        3. If workoutType is 'cardio', DO NOT include core, abs, or mobility exercises in the array. Dedicate the day entirely to running metrics.
        4. If workoutType is 'rest', the exercises array MUST be completely empty.
        5. Ensure progressive overload and proper RPE allocation across weeks.

        INJURY SAFETY:
        6. Respect the listed injuries/limitations: avoid or regress any contraindicated movement and program a safer alternative. If "None reported", program normally.${cycleAwareBlock}
    `;

    return callWithRetry(model, prompt, maxRetries);
};

// The half the athlete brings vs. the half we have to write. Keyed by the domain they supplied.
const DOMAIN_LABELS = {
    strength: { own: 'strength (gym)', missing: 'cardio', missingLabel: 'cardio (running)' },
    cardio: { own: 'cardio (running)', missing: 'strength', missingLabel: 'strength (gym)' }
};

/**
 * @desc  Parse a training program the athlete already follows and complete the missing half.
 *
 * The athlete supplies one domain (their gym block, or their running block) as pasted text and/or
 * PDF/photo attachments. Gemini normalizes that material into our plan schema *verbatim* and
 * authors only the complementary domain around it, so the app renders a single merged macrocycle.
 *
 * @param {object} userProfile              persisted user document merged with request overrides
 * @param {object} options
 * @param {'strength'|'cardio'} options.providedDomain  which half the athlete brought
 * @param {number} options.planDuration     weeks the merged plan must span
 * @param {string} options.sourceText       routine pasted as plain text (may be empty)
 * @param {Array<{mimeType: string, data: string}>} options.attachments  base64 PDFs/images
 */
export const importAndCompleteWorkoutPlan = async (
    userProfile,
    { providedDomain, planDuration, sourceText = '', attachments = [] },
    maxRetries = 3
) => {
    const model = genAI.getGenerativeModel({
        model: MODEL_ID,
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: importedWorkoutPlanSchema
        }
    });

    const { own, missing, missingLabel } = DOMAIN_LABELS[providedDomain];
    const injuriesList = formatInjuries(userProfile);
    const cycleAwareBlock = buildCycleAwareBlock(userProfile);

    const pastedBlock = sourceText
        ? `
        THE ATHLETE'S OWN ${own.toUpperCase()} PROGRAM (pasted as text):
        """
        ${sourceText}
        """`
        : '';

    const attachmentBlock = attachments.length > 0
        ? `
        The athlete also attached ${attachments.length} document(s)/image(s) at the start of this request. They contain their own ${own} program — read them.`
        : '';

    const prompt = `
        Act as an elite Hybrid Training coach. The athlete ALREADY follows their own ${own} program and
        wants you to build the ${missingLabel} half around it. Return ONE merged, progressive
        ${planDuration}-week macrocycle containing both halves.
${pastedBlock}${attachmentBlock}

        Profile:
        - Goal: ${userProfile.goal}
        - Experience: ${userProfile.fitnessLevel}
        - Availability: ${userProfile.daysAvailable} days/week
        - Weight: ${userProfile.weight}kg
        - Sex: ${userProfile.sex}
        - Injuries / limitations: ${injuriesList}

        CRITICAL IMPORT RULES:
        1. FIDELITY: The material above is the athlete's own ${own} programming. Reproduce it FAITHFULLY —
           same exercises, same order, same sets, same reps, same RPE. DO NOT rewrite it, DO NOT adjust its
           volume or intensity, DO NOT substitute exercises, DO NOT add exercises to it. Only normalize its
           formatting into the output schema: 'sets', 'reps' and 'rpe' are STRINGS, and where the source does
           not state a value use "-". Every day taken from this material MUST have workoutType '${providedDomain}'
           and source 'imported'.
        2. COMPLETION: You author ONLY the ${missing} half. Every day you write yourself MUST have workoutType
           '${missing}' (or 'rest') and source 'generated'. Never write a '${providedDomain}' day of your own.
        3. DOMAIN ISOLATION: DO NOT mix strength (gym) and cardio (running/cycling) in the same session. A
           session is strictly 100% 'strength', 100% 'cardio', or 'rest'.
        4. If workoutType is 'cardio', DO NOT include core, abs, or mobility exercises in the array. Dedicate
           the day entirely to running metrics. If workoutType is 'rest', the exercises array MUST be
           completely empty and source MUST be 'generated'.
        5. COVERAGE: The output MUST span exactly ${planDuration} weeks, numbered 1..${planDuration}. If the
           athlete's material covers fewer weeks, repeat its structure across the remaining weeks, progressing
           it the way the material itself progresses. Those days stay source 'imported'.
        6. BUDGET: Total training sessions in a single week must not exceed ${userProfile.daysAvailable}.
           Keep EVERY imported day and fit the ${missing} sessions and rest days around them. Never drop or
           merge an imported day to make room.
        7. Apply progressive overload and sensible RPE allocation across weeks to the ${missing} half only.
        8. If the material contains no recognizable training program, return an empty "weeks" array.

        INJURY SAFETY:
        9. Respect the listed injuries/limitations in the ${missing} half you author: avoid or regress any
           contraindicated movement and program a safer alternative. Do NOT alter the imported half for this
           reason. If "None reported", program normally.${cycleAwareBlock}
    `;

    // Attachments first so the model reads the source material before the instructions.
    const contents = [
        ...attachments.map((file) => ({
            inlineData: { mimeType: file.mimeType, data: file.data }
        })),
        { text: prompt }
    ];

    return callWithRetry(model, contents, maxRetries);
};

// @desc    Process a chat message maintaining context
// planContext is an already-resolved text summary of the user's active plan (may be empty).
export const processChatMessage = async (chatHistoryMessages, newMessage, planContext = '') => {
    const baseInstruction = 'You are an elite Hybrid Training AI Coach. Answer questions concisely and professionally.';
    const systemInstruction = planContext
        ? `${baseInstruction}\n\nHere is the user's current training plan, use it to answer questions about their routine:\n${planContext}`
        : baseInstruction;

    const model = genAI.getGenerativeModel({
        model: MODEL_ID,
        systemInstruction
    });

    // Map prior turns to Gemini contents[]; the current message is appended as the last
    // 'user' turn by sendMessage below.
    const formattedHistory = chatHistoryMessages.map(msg => ({
        role: msg.role,
        parts: [{ text: msg.content }]
    }));

    const chat = model.startChat({ history: formattedHistory });
    const result = await chat.sendMessage(newMessage);
    return result.response.text();
};
