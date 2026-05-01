// src/routes/userRoutes.js
import express from 'express';
import { registerUser } from '../controllers/userController.js';

const router = express.Router();

// Map the POST request to the registerUser controller function
router.post('/', registerUser);

export default router;