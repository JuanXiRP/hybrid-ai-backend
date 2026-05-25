import express from 'express';
import { registerUser, updateUserProfile } from '../controllers/userController.js';
import { protect } from '../middleware/authMiddleware.js'; 

const router = express.Router();

router.post('/', registerUser);

router.patch('/profile', protect, updateUserProfile);

export default router;