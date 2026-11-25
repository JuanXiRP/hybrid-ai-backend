import User from "../models/User.js";
import WorkoutPlan from "../models/WorkoutPlan.js";
import generateToken from "../utils/generateToken.js";
import { OAuth2Client } from "google-auth-library";

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
    const userExists = await User.findOne({ email }).setOptions({
      sanitizeFilter: true,
    });
    if (userExists) {
      return res.status(400).json({
        success: false,
        message: "User already exists with that email",
      });
    }

    // 2. Create the user (password is hashed automatically by the Mongoose pre-save hook)
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
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// @desc    Login user and get token
// @route   POST /api/auth/login
// @access  Public
export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email })
      .setOptions({ sanitizeFilter: true })
      .select("+password");

    if (!user) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }

    // An account created through Google has no password to compare against. Saying so is far
    // more useful than "Invalid credentials", which sends the user round the loop of trying a
    // password that never existed. This does reveal that the account exists — a deliberate
    // trade-off, and no worse than registerUser, which already answers "User already exists
    // with that email".
    if (!user.password && user.googleId) {
      return res.status(401).json({
        success: false,
        message: "This account uses Google Sign-In. Continue with Google.",
      });
    }

    if (!(await user.matchPassword(password))) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }

    // Onboarding counts as complete once a generated plan exists
    const hasPlan = await WorkoutPlan.exists({ userId: user._id });

    res.status(200).json({
      success: true,
      token: generateToken(user._id),
      has_completed_onboarding: !!hasPlan, // snake_case, matching the client's @SerialName
      data: { id: user._id, name: user.name, email: user.email },
    });
  } catch (error) {
    console.error("[Login Error]:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const googleLogin = async (req, res) => {
  try {
    const { idToken } = req.body;

    // 1. Verify the token with Google (never trust the client)
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_WEB_CLIENT_ID, // must match Android client's webClientId
    });
    const {
      sub: googleId,
      email: rawEmail,
      email_verified: emailVerified,
      name,
    } = ticket.getPayload();

    // An unverified address proves nothing about who owns it, and linking by email is only safe
    // when Google vouches for it.
    if (emailVerified !== true || !rawEmail) {
      return res.status(401).json({
        success: false,
        message: "Your Google account email is not verified.",
      });
    }
    const email = rawEmail.toLowerCase();

    // 2. Find or create. The stable Google id wins; the email is only a fallback for linking an
    // existing email/password account, and never overrides a different Google identity.
    let user = await User.findOne({ googleId }).setOptions({
      sanitizeFilter: true,
    });

    if (!user) {
      user = await User.findOne({ email }).setOptions({
        sanitizeFilter: true,
      });

      if (!user) {
        user = await User.create({
          googleId,
          email,
          name: name || email.split("@")[0],
        });
      } else if (!user.googleId) {
        // Verified email = proof of ownership: link Google to the existing account.
        user.googleId = googleId;
        await user.save();
      } else {
        return res.status(409).json({
          success: false,
          message: "This email is linked to a different Google account.",
        });
      }
    }

    // 3. Same onboarding logic as standard login
    const hasPlan = await WorkoutPlan.exists({ userId: user._id });

    res.status(200).json({
      success: true,
      token: generateToken(user._id),
      has_completed_onboarding: !!hasPlan,
      data: { id: user._id, name: user.name, email: user.email },
    });
  } catch (error) {
    console.error("[Google Login Error]:", error);
    res
      .status(401)
      .json({ success: false, message: "Google authentication failed" });
  }
};
