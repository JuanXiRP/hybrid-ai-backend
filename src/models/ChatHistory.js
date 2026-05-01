import mongoose from 'mongoose';

const chatHistorySchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true,
            ref: 'User',
            // Ensures only one active chat history document per user
            unique: true 
        },
        // Array storing the chronological conversation
        messages: [
            {
                role: {
                    type: String,
                    enum: ['user', 'model'],
                    required: true
                },
                content: {
                    type: String,
                    required: true
                },
                timestamp: {
                    type: Date,
                    default: Date.now
                }
            }
        ]
    },
    {
        timestamps: true
    }
);

export default mongoose.model('ChatHistory', chatHistorySchema);