// src/models/User.js
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema(
    {
        name: { type: String, required: [true, 'Name is required'], trim: true },
        email: { type: String, required: [true, 'Email is required'], unique: true, lowercase: true, trim: true },
        password: { type: String, required: [true, 'Password is required'], minlength: [6, 'Password must be at least 6 characters'], select: false },
        
        // Physical profile fields: Optional at registration, validated during Onboarding API call
        age: {
            type: Number,
            required: false,
            min: [16, 'Age must be at least 16']
        },
        weight: {
            type: Number,
            required: false,
            min: [30, 'Weight must be greater than 30kg']
        },
        height: {
            type: Number,
            required: false,
            min: [100, 'Height must be greater than 100cm']
        },
        sex: {
            type: String,
            enum: ['male', 'female', 'other'],
            required: false
        },
        goal: {
            type: String,
            enum: {
                values: ['endurance', 'strength', 'both'],
                message: '{VALUE} is not a valid goal'
            },
            required: false
        },
        fitnessLevel: {
            type: String,
            enum: {
                values: ['beginner', 'intermediate', 'advanced'],
                message: '{VALUE} is not a valid fitness level'
            },
            required: false
        },
        daysAvailable: {
            type: Number,
            required: false,
            min: [1, 'Must be at least 1 day'],
            max: [7, 'Cannot exceed 7 days']
        },
        planDuration: {
            type: Number,
            enum: {
                values: [4, 8, 12],
                message: '{VALUE} is not a valid duration. Choose 4, 8, or 12.'
            },
            required: false
        },
        injuries: { type: [String], default: [] },
        isPremium: { type: Boolean, default: false }
    },
    { timestamps: true }
);

// Pre-save hook to hash the password before saving to the database
userSchema.pre('save', async function (next) {
    if (!this.isModified('password')) return next();
    try {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (error) {
        next(error);
    }
});

userSchema.methods.matchPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

export default mongoose.model('User', userSchema);