import User from '../models/User.js';
import jwt from 'jsonwebtoken';

// Helper function to generate a JWT token
const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN,
    });
};

// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
export const registerUser = async (req, res) => {
    try {
        const { name, email, password, age, height, weight, sex, goal, fitnessLevel, daysAvailable, planDuration } = req.body;

        // 1. Check if user already exists
        const userExists = await User.findOne({ email });
        if (userExists) {
            return res.status(400).json({ success: false, message: 'User already exists with that email' });
        }

        // 2. Create the user (Password is hashed automatically by our Mongoose hook)
        const user = await User.create({
            name, email, password, age, height, weight, sex, goal, fitnessLevel, daysAvailable, planDuration
        });

        // 3. Return the token and basic user data
        res.status(201).json({
            success: true,
            token: generateToken(user._id),
            data: { id: user._id, name: user.name, email: user.email }
        });
    } catch (error) {
        console.error("[Register Error]:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// @desc    Login user and get token
// @route   POST /api/auth/login
// @access  Public
export const loginUser = async (req, res) => {
    try {
        const { email, password } = req.body;

        // 1. Find user by email and explicitly pull the password field (we set select: false in the model)
        const user = await User.findOne({ email }).select('+password');

        // 2. Check if user exists AND password matches the hash
        if (!user || !(await user.matchPassword(password))) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        // 3. Send back the token
        res.status(200).json({
            success: true,
            token: generateToken(user._id),
            data: { id: user._id, name: user.name, email: user.email }
        });
    } catch (error) {
        console.error("[Login Error]:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};