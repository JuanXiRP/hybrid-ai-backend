import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export const protect = async (req, res, next) => {
    // Check if the authorization header exists and starts with 'Bearer'
    if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer')) {
        return res.status(401).json({ success: false, message: 'Not authorized, no token' });
    }

    try {
        // Get token from header (Format: "Bearer <token>")
        const token = req.headers.authorization.split(' ')[1];

        // Verify the token using our secret key
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Fetch the user from the DB and attach it to the request object (excluding password)
        const user = await User.findById(decoded.id).select('-password');

        // A validly-signed token for a deleted user would otherwise leave req.user null and
        // crash every controller on req.user._id.
        if (!user) {
            return res.status(401).json({ success: false, message: 'Not authorized, user not found' });
        }

        req.user = user;

        // Move to the next middleware or controller
        return next();
    } catch (error) {
        console.error("[Auth Middleware Error]:", error);
        return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
    }
};
