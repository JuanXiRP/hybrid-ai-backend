import mongoose from 'mongoose';

const workoutPlanSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true // Speeds up queries fetching plans for a specific user
        },
        startDate: { type: Date, default: Date.now },
        durationWeeks: { type: Number, required: true },
        goal: { type: String, required: true },
        weeks: [
            {
                weekNumber: Number,
                days: [
                    {
                        dayName: String,
                        workoutType: {
                            type: String,
                            enum: ['strength', 'cardio', 'rest'],
                            required: true,
                            default: 'rest'
                        },
                        // Provenance of the session. 'imported' means the day was parsed from a
                        // program the athlete supplied; everything the AI wrote itself is
                        // 'generated', which is also how every plan created before this field
                        // existed reads back.
                        source: {
                            type: String,
                            enum: ['imported', 'generated'],
                            default: 'generated'
                        },
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
            default: true,
            index: true // Speeds up the query looking for the currently active plan
        },
        // 'imported' when the plan was built around a program the athlete brought in. The days
        // themselves carry the finer-grained `source`.
        origin: {
            type: String,
            enum: ['imported', 'generated'],
            default: 'generated'
        }
    },
    { timestamps: true }
);

// Compound index for the most common query: finding a user's active plan
workoutPlanSchema.index({ userId: 1, active: 1 });

export default mongoose.model('WorkoutPlan', workoutPlanSchema);