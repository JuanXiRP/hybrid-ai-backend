// src/services/geminiService.js
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper function to pause execution
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// @desc    Generate a tailored workout plan using Gemini AI with retry logic
export const generateWorkoutPlan = async (userProfile, maxRetries = 3) => {
    const model = genAI.getGenerativeModel({ 
        model: "gemini-2.5-flash", 
        generationConfig: {
            responseMimeType: "application/json",
        }
    });

    const prompt = `
        Act as an expert personal trainer. Create a ${userProfile.planDuration}-week workout plan for a user with the following profile:
        - Goal: ${userProfile.goal}
        - Fitness Level: ${userProfile.fitnessLevel}
        - Days available: ${userProfile.daysAvailable} days per week
        - Current Weight: ${userProfile.weight}kg
        - Gender: ${userProfile.sex}
        
        Return the response exclusively in a valid JSON format. The JSON must be structured week by week. For each week, detail the specific days, exercise names, sets, reps, and target RPE to ensure progressive overload across the ${userProfile.planDuration} weeks. Do not use markdown blocks, just raw JSON.
    `;

    // Implement Exponential Backoff for resilience against 503/429 errors
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await model.generateContent(prompt);
            const response = await result.response;
            return response.text();
        } catch (error) {
            const isRateLimitOrUnavailable = error.status === 503 || error.status === 429;
            
            if (isRateLimitOrUnavailable && attempt < maxRetries) {
                // Calculate wait time: 2s, 4s, 8s...
                const waitTime = Math.pow(2, attempt) * 1000;
                console.warn(`[Gemini API] Server busy (503). Retrying attempt ${attempt} of ${maxRetries} in ${waitTime}ms...`);
                await delay(waitTime);
            } else {
                console.error("[Gemini API Error]:", error);
                throw new Error("Failed to connect to Gemini AI after multiple attempts");
            }
        }
    }
};