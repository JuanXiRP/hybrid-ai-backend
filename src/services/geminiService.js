// src/services/geminiService.js
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper function to pause execution for retry logic
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 🟢 1. Schema Enhancement: Added 'workoutType' enum to strictly segregate UI rendering states
const workoutPlanSchema = {
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
                            properties: {
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
                            },
                            required: ["dayName", "workoutType", "exercises"] // 🟢 Enforces the backend flag
                        }
                    }
                },
                required: ["weekNumber", "days"]
            }
        }
    },
    required: ["durationWeeks", "goal", "weeks"]
};

// @desc    Generate a tailored workout plan using Gemini AI with retry logic
export const generateWorkoutPlan = async (userProfile, maxRetries = 3) => {
    const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash-lite",
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: workoutPlanSchema
        }
    });

    // 🟢 Injuries: always surfaced so the model can regress/avoid contraindicated movements.
    const injuriesList = Array.isArray(userProfile.injuries) && userProfile.injuries.length > 0
        ? userProfile.injuries.join(', ')
        : 'None reported';

    // 🟢 Cycle-aware block: only for female athletes with a known last period date.
    const isFemaleWithCycle = userProfile.sex === 'female' && userProfile.last_period_date;
    const cycleAwareBlock = isFemaleWithCycle
        ? `

        MENSTRUAL CYCLE AWARENESS (female athlete):
        - Last menstrual period start date: ${userProfile.last_period_date} (ISO yyyy-MM-dd).
        - Today's date: ${new Date().toISOString().slice(0, 10)} (ISO yyyy-MM-dd).
        - Estimate the current cycle phase from these two dates (assume a ~28-day cycle) and modulate training LOAD (intensity/volume) accordingly — never remove training days, only adjust their demand:
          * Menstrual / early follicular: keep intensity moderate; prioritize technique, mobility and recovery.
          * Late follicular / ovulation: schedule the highest-intensity strength and interval sessions (peak performance window).
          * Luteal: progressively reduce peak intensity, favor aerobic/volume work, and add a deload toward the late luteal phase.
        - Keep this modulation consistent with the progressive overload of the macrocycle.`
        : '';

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

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await model.generateContent(prompt);
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

// @desc    Process a chat message maintaining context
// planContext is an already-resolved text summary of the user's active plan (may be empty).
export const processChatMessage = async (chatHistoryMessages, newMessage, planContext = '') => {
    const baseInstruction = 'You are an elite Hybrid Training AI Coach. Answer questions concisely and professionally.';
    const systemInstruction = planContext
        ? `${baseInstruction}\n\nHere is the user's current training plan, use it to answer questions about their routine:\n${planContext}`
        : baseInstruction;

    const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash-lite",
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
