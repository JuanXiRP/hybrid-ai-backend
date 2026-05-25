// src/controllers/userController.js
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

// @desc    Register a new user
// @route   POST /api/users
// @access  Public
export const registerUser = async (req, res) => {
    try {
        // 1. Create the user
        const user = await User.create(req.body);

        // 2. Generate the JWT token (fabricamos la llave)
        const token = jwt.sign(
            { id: user._id }, 
            process.env.JWT_SECRET, 
            { expiresIn: '30d' } // El token caduca en 30 días
        );

        // 3. Return the token ALONG with the user data
        res.status(201).json({
            success: true,
            token: token, // <-- AQUÍ ESTÁ EL TOKEN
            data: user
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
};
// @desc    Update user profile with onboarding biometrics
// @route   PATCH /api/users/profile
// @access  Private (Requires JWT token)
export const updateUserProfile = async (req, res) => {
    try {
        // 1. Destructure the expected payload for explicit validation
        const { age, weight, height, sex, goal, fitnessLevel, daysAvailable, planDuration } = req.body;

        // 2. Strict API-level validation
        // Enforces that the onboarding payload is 100% complete before touching the database
        if (!age || !weight || !height || !sex || !goal || !fitnessLevel || !daysAvailable || !planDuration) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed: All physical profile fields (age, weight, height, sex, goal, fitnessLevel, daysAvailable, planDuration) are strictly required.'
            });
        }

        // 3. Database operation
        // req.user.id should be injected by your JWT authentication middleware
        const updatedUser = await User.findByIdAndUpdate(
            req.user.id,
            {
                $set: req.body
            },
            {
                new: true, // Returns the modified document
                runValidators: true // Enforces the min/max/enum rules defined in the schema
            }
        );

        if (!updatedUser) {
            return res.status(404).json({
                success: false,
                message: 'User not found in database'
            });
        }

        res.status(200).json({
            success: true,
            data: updatedUser
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
};