import express from 'express';
import { registerUser, updateUserProfile, getUserProfile } from '../controllers/userController.js'; // 🟢 Import added
import { protect } from '../middleware/authMiddleware.js'; 

const router = express.Router();

// Public route for account registration
router.post('/', registerUser);

// Private route to update onboarding profile data
router.patch('/profile', protect, updateUserProfile);

// 🟢 Private route to fetch profile metadata for the Settings screen
router.get('/profile', protect, getUserProfile);

export default router;