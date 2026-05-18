import express from 'express';
import { registerUser, updateUserProfile } from '../controllers/userController.js';
import { protect } from '../middleware/authMiddleware.js'; 

const router = express.Router();

// Esta es la ruta que ya tenías para crear el usuario en Postman/Thunder Client
router.post('/', registerUser);

// ---> ESTA ES LA RUTA QUE TE FALTA <---
// Escucha peticiones PATCH en /api/users/profile, pasa por el 'protect', y ejecuta la actualización
router.patch('/profile', protect, updateUserProfile);

export default router;