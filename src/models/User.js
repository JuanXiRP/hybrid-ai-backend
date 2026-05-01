// src/models/User.js
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Name is required'],
            trim: true
        },
        email: {
            type: String,
            required: [true, 'Email is required'],
            unique: true,
            lowercase: true,
            trim: true
        },
        password: {
            type: String,
            required: [true, 'Password is required'],
            minlength: [6, 'Password must be at least 6 characters'],
            select: false // Prevents password from being returned in queries by default
        },
        age: {
            type: Number,
            required: [true, 'Age is required'],
            min: [16, 'Age must be at least 16']
        },
        weight: {
            type: Number,
            required: [true, 'Weight is required in kg'],
            min: [30, 'Weight must be greater than 30kg']
        },
        height: {
            type: Number,
            required: [true, 'Height is required in cm'],
            min: [100, 'Height must be greater than 100cm']
        },
        sex: {
            type: String,
            enum: ['male', 'female', 'other'],
            required: [true, 'Sex is required']
        },
        goal: {
            type: String,
            enum: {
                values: ['endurance', 'strength', 'both'],
                message: '{VALUE} is not a valid goal'
            },
            required: [true, 'Goal is required']
        },
        fitnessLevel: {
            type: String,
            enum: {
                values: ['beginner', 'intermediate', 'advanced'],
                message: '{VALUE} is not a valid fitness level'
            },
            required: [true, 'Fitness level is required']
        },
        daysAvailable: {
            type: Number,
            required: [true, 'Available training days are required'],
            min: [1, 'Must be at least 1 day'],
            max: [7, 'Cannot exceed 7 days']
        },
        planDuration: {
            type: Number,
            enum: {
                values: [4, 8, 12],
                message: '{VALUE} is not a valid duration. Choose 4, 8, or 12.'
            },
            required: [true, 'Plan duration in weeks is required']
        },
        injuries: {
            type: [String],
            default: []
        },
        isPremium: {
            type: Boolean,
            default: false
        }
    },
    {
        // Automatically manages createdAt and updatedAt properties
        timestamps: true
    }
);
// Pre-save hook to hash the password before saving to the database
userSchema.pre('save', async function (next) {
    // Only run this function if password was modified (not on other update functions)
    if (!this.isModified('password')) return next();

    try {
        // Generate a salt and hash the password
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (error) {
        next(error);
    }
});

// Method to compare entered password with the hashed password in the database
userSchema.methods.matchPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

export default mongoose.model('User', userSchema);