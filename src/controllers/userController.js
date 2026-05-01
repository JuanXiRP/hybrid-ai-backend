// src/controllers/userController.js
import User from '../models/User.js';

// @desc    Register a new user
// @route   POST /api/users
// @access  Public
export const registerUser = async (req, res) => {
    try {
        // Create the user using the data sent in the request body
        const user = await User.create(req.body);

        // Return a 201 Created status and the user data
        res.status(201).json({
            success: true,
            data: user
        });
    } catch (error) {
        // If validation fails (e.g., missing required fields), return a 400 Bad Request
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
};