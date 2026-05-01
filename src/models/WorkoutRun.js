import mongoose from 'mongoose';

const workoutRunSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true,
            ref: 'User'
        },
        date: {
            type: Date,
            default: Date.now
        },
        distance: {
            // Distance stored in kilometers
            type: Number, 
            required: [true, 'Distance is required']
        },
        duration: {
            // Duration stored in total minutes to facilitate backend calculations
            type: Number, 
            required: [true, 'Duration is required']
        },
        targetPace: {
            // Expected format: "MM:SS"
            type: String, 
            required: true
        },
        actualPace: {
            type: String
        },
        elevationGain: {
            // Elevation gain stored in meters
            type: Number, 
            default: 0
        },
        // Array to store GPS route points for the tracking feature
        gpsPath: [
            {
                lat: { type: Number },
                lng: { type: Number }
            }
        ],
        // Overall session RPE
        rpe: {
            type: Number,
            min: 1,
            max: 10
        }
    },
    {
        timestamps: true
    }
);

export default mongoose.model('WorkoutRun', workoutRunSchema);