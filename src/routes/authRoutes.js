import express from "express";
import { authLimiter } from "../middleware/rateLimit.js";
import { validateBody } from "../validation/validateBody.js";
import {
  loginSchema,
  googleLoginSchema,
  registerSchema,
} from "../validation/schemas.js";
import {
  registerUser,
  loginUser,
  googleLogin,
} from "../controllers/authController.js";

const router = express.Router();

// Guessing a password is only an attack if you can try many times.
router.use(authLimiter);

router.post("/register", validateBody(registerSchema), registerUser);
router.post("/login", validateBody(loginSchema), loginUser);
router.post("/google", validateBody(googleLoginSchema), googleLogin);

export default router;
