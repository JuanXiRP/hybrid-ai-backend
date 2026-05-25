import mongoose from 'mongoose';

const workoutStrengthSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true,
            ref: 'User',
            index: true
        },
        date: { type: Date, default: Date.now },
        routineType: { type: String, required: [true, 'Routine type is required'] },
        exercises: [
            {
                exerciseName: { type: String, required: true },
                sets: { type: Number, required: true },
                reps: { type: Number, required: true },
                targetWeight: { type: Number, required: true },
                actualWeight: { type: Number },
                targetRpe: { type: Number, required: true, min: 1, max: 10 },
                actualRpe: { type: Number, min: 1, max: 10 }
            }
        ]
    },
    { timestamps: true }
);

export default mongoose.model('WorkoutStrength', workoutStrengthSchema);