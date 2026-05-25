import mongoose from 'mongoose';

const workoutRunSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true,
            ref: 'User',
            index: true
        },
        date: { type: Date, default: Date.now },
        distance: { type: Number, required: [true, 'Distance is required'] },
        duration: { type: Number, required: [true, 'Duration is required'] },
        
        // Pace stored strictly in total seconds per kilometer (e.g., 330 for 05:30 min/km)
        targetPace: {
            type: Number, 
            required: true
        },
        actualPace: {
            type: Number
        },
        elevationGain: { type: Number, default: 0 },
        gpsPath: [
            {
                lat: { type: Number },
                lng: { type: Number }
            }
        ],
        rpe: { type: Number, min: 1, max: 10 }
    },
    { timestamps: true }
);

export default mongoose.model('WorkoutRun', workoutRunSchema);