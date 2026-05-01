// src/models/WorkoutPlan.js
import mongoose from 'mongoose';

const workoutPlanSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        startDate: {
            type: Date,
            default: Date.now
        },
        durationWeeks: {
            type: Number,
            required: true
        },
        goal: {
            type: String,
            required: true
        },
        // Store the complete AI-generated JSON structure
        weeks: [
            {
                weekNumber: Number,
                days: [
                    {
                        dayName: String,
                        exercises: [
                            {
                                name: String,
                                sets: String,
                                reps: String,
                                rpe: String
                            }
                        ]
                    }
                ]
            }
        ],
        active: {
            type: Boolean,
            default: true
        }
    },
    {
        timestamps: true
    }
);

export default mongoose.model('WorkoutPlan', workoutPlanSchema);