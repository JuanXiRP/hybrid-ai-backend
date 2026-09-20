import express from "express";
import { authLimiter } from "../middleware/rateLimit.js";
import {
  registerUser,
  loginUser,
  googleLogin,
} from "../controllers/authController.js";

const router = express.Router();

// Guessing a password is only an attack if you can try many times.
router.use(authLimiter);

router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/google", googleLogin);

export default router;
