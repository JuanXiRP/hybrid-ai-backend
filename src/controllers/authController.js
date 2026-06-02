import User from "../models/User.js";
import WorkoutPlan from '../models/WorkoutPlan.js';
import generateToken from "../utils/generateToken.js";
import { OAuth2Client } from 'google-auth-library';

const googleClient = new OAuth2Client();

// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
export const registerUser = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      age,
      height,
      weight,
      sex,
      goal,
      fitnessLevel,
      daysAvailable,
      planDuration,
    } = req.body;

    // 1. Check if user already exists
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res
        .status(400)
        .json({
          success: false,
          message: "User already exists with that email",
        });
    }

    // 2. Create the user (Password is hashed automatically by our Mongoose hook)
    const user = await User.create({
      name,
      email,
      password,
      age,
      height,
      weight,
      sex,
      goal,
      fitnessLevel,
      daysAvailable,
      planDuration,
    });

    // 3. Return the token and basic user data
    res.status(201).json({
      success: true,
      token: generateToken(user._id),
      data: { id: user._id, name: user.name, email: user.email },
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

        const user = await User.findOne({ email }).select('+password');

        if (!user || !(await user.matchPassword(password))) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        // 🟢 El onboarding se da por completo cuando existe un plan generado
        const hasPlan = await WorkoutPlan.exists({ userId: user._id });

        res.status(200).json({
            success: true,
            token: generateToken(user._id),
            has_completed_onboarding: !!hasPlan,   // 🟢 snake_case, casa con tu @SerialName
            data: { id: user._id, name: user.name, email: user.email }
        });
    } catch (error) {
        console.error("[Login Error]:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

export const googleLogin = async (req, res) => {
    try {
        const { idToken } = req.body;
        if (!idToken) {
            return res.status(400).json({ success: false, message: 'idToken is required' });
        }

        // 1. Verificar el token CON Google (no nos fiamos del cliente)
        const ticket = await googleClient.verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_WEB_CLIENT_ID, // el mismo webClientId del cliente Android
        });
        const { sub: googleId, email, name } = ticket.getPayload();

        // 2. Buscar o crear
        let user = await User.findOne({ $or: [{ googleId }, { email }] });
        if (!user) {
            user = await User.create({ googleId, email, name: name || email.split('@')[0] });
        } else if (!user.googleId) {
            // Usuario que ya existía con email/password y ahora entra con Google: enlazamos cuentas
            user.googleId = googleId;
            await user.save();
        }

        // 3. Mismo criterio de onboarding que el login normal
        const hasPlan = await WorkoutPlan.exists({ userId: user._id });

        res.status(200).json({
            success: true,
            token: generateToken(user._id),
            has_completed_onboarding: !!hasPlan,
            data: { id: user._id, name: user.name, email: user.email }
        });
    } catch (error) {
        console.error("[Google Login Error]:", error);
        res.status(401).json({ success: false, message: 'Google authentication failed' });
    }
};
