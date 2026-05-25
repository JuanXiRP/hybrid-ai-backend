// src/services/geminiService.js
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai'; // 🟢 Import SchemaType
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper function to pause execution
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// @desc    Generate a tailored workout plan using Gemini AI with retry logic
// 🟢 1. Define the explicit JSON Schema that matches your Mongoose/Android models
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
                                    description: "Name of the day or session focus, e.g., 'Lower Body', 'Running', 'Rest'"
                                },
                                exercises: {
                                    type: SchemaType.ARRAY,
                                    description: "List of exercises for this specific day",
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
                            required: ["dayName", "exercises"]
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
    // 🟢 2. Pass the schema to the generation config
    const model = genAI.getGenerativeModel({ 
        model: "gemini-2.5-flash-lite", 
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: workoutPlanSchema // Enforces the structure
        }
    });

    // 3. Keep the prompt focused on the training logic, not the JSON formatting
    const prompt = `
        Act as an elite Hybrid Training coach. Create a progressive ${userProfile.planDuration}-week macrocycle.
        Profile:
        - Goal: ${userProfile.goal}
        - Experience: ${userProfile.fitnessLevel}
        - Availability: ${userProfile.daysAvailable} days/week
        - Weight: ${userProfile.weight}kg
        - Sex: ${userProfile.sex}
        
        Ensure progressive overload, proper recovery days, and specific RPE targets based on the user's experience level.
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
export const processChatMessage = async (chatHistoryMessages, newMessage, userRoutineContext) => {
    const model = genAI.getGenerativeModel({ 
        model: "gemini-2.5-flash-lite",
        systemInstruction: `You are an elite Hybrid Training AI Coach. Context of the user's current routine: ${JSON.stringify(userRoutineContext)}. Answer questions concisely and professionally.`
    });

    // Format previous MongoDB messages to Gemini API format
    const formattedHistory = chatHistoryMessages.map(msg => ({
        role: msg.role,
        parts: [{ text: msg.content }]
    }));

    const chat = model.startChat({ history: formattedHistory });
    const result = await chat.sendMessage(newMessage);
    return result.response.text();
};