const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");
const rateLimit = require("express-rate-limit");

const User = require("../models/User");
const passwordResetEmailService = require("../services/passwordResetEmailService");
const PlatformSetting = require("../models/PlatformSetting");

const router = express.Router();

const COOKIE_NAME = "ptw_session";
const TOKEN_LIFETIME = "1d";

function createToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      role: user.role,
      sv: Number(user.sessionVersion || 0)
    },
    process.env.JWT_SECRET,
    {
      expiresIn: TOKEN_LIFETIME,
      issuer: "primetask-workspace",
      audience: "primetask-workspace-users"
    }
  );
}

function setSessionCookie(res, token, remember = false) {
  const production = process.env.NODE_ENV === "production";

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: production,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    path: "/",
    maxAge: remember ? 7 * 24 * 60 * 60 * 1000 : undefined
  });
}

function publicUser(user) {
  return {
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    email: user.email,
    phone: user.phone,
    profilePictureUrl: user.profilePictureUrl || null,
    role: user.role,
    status: user.status,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many password reset requests. Try again later."
  }
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many password reset attempts. Try again later."
  }
});

const PASSWORD_RESET_RESPONSE = {
  success: true,
  message: "If an account exists for that email, password reset instructions will be sent."
};

/*
 * POST /api/auth/forgot-password
 */
router.post("/forgot-password", forgotPasswordLimiter, async (req, res) => {
  const email = normalizeText(req.body?.email).toLowerCase();

  if (
    !email ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return res.status(200).json(PASSWORD_RESET_RESPONSE);
  }

  try {
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(200).json(PASSWORD_RESET_RESPONSE);
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    user.passwordResetTokenHash = tokenHash;
    user.passwordResetExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();

    try {
      await passwordResetEmailService.sendPasswordResetEmail({
        email: user.email,
        firstName: user.firstName,
        token: rawToken
      });
    } catch (emailError) {
      user.passwordResetTokenHash = null;
      user.passwordResetExpiresAt = null;
      await user.save().catch(() => {});
      console.error("Password reset email delivery failed:", emailError.message);
    }

    return res.status(200).json(PASSWORD_RESET_RESPONSE);
  } catch (error) {
    console.error("Password reset request failed:", error.message);
    return res.status(200).json(PASSWORD_RESET_RESPONSE);
  }
});

/*
 * POST /api/auth/reset-password
 */
router.post("/reset-password", resetPasswordLimiter, async (req, res) => {
  const token = req.body?.token;
  const password = req.body?.password;

  if (
    typeof token !== "string" ||
    !/^[a-f0-9]{64}$/i.test(token) ||
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 72
  ) {
    return res.status(400).json({
      success: false,
      message: "The reset link is invalid or expired, or the password does not meet the requirements."
    });
  }

  try {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const passwordHash = await bcrypt.hash(password, 12);

    const updatedUser = await User.findOneAndUpdate(
      {
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: { $gt: new Date() }
      },
      {
        $set: { passwordHash },
        $unset: {
          passwordResetTokenHash: 1,
          passwordResetExpiresAt: 1
        },
        $inc: { sessionVersion: 1 }
      },
      {
        new: true,
        runValidators: true
      }
    ).select("_id");

    if (!updatedUser) {
      return res.status(400).json({
        success: false,
        message: "The reset link is invalid or expired, or the password does not meet the requirements."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Your password has been reset. Sign in using your new password."
    });
  } catch (error) {
    console.error("Password reset failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to reset your password right now. Please try again later."
    });
  }
});

/*
 * POST /api/auth/register
 */
router.post("/register", async (req, res) => {
  try {
    const platformSettings = await PlatformSetting.findOne({ key: "platform" }).lean();
    if (platformSettings && (platformSettings.maintenanceMode || !platformSettings.registrationEnabled)) {
      return res.status(503).json({
        success: false,
        message: platformSettings.maintenanceMode
          ? "Registration is temporarily unavailable while the platform is under maintenance."
          : "New account registration is temporarily disabled."
      });
    }
    const firstName = normalizeText(req.body.firstName);
    const lastName = normalizeText(req.body.lastName);
    const username = normalizeText(req.body.username).toLowerCase();
    const email = normalizeText(req.body.email).toLowerCase();
    const phone = normalizeText(req.body.phone);
    const sponsorUsername = normalizeText(
      req.body.sponsorUsername || ""
    ).toLowerCase();
    const password = req.body.password;
    const termsAccepted = req.body.termsAccepted;
    const selectedService = normalizeText(req.body.selectedService || "").toLowerCase();
    const allowedServices = [
      "transcription",
      "note-taking",
      "data-entry",
      "academic-writing"
    ];

    if (selectedService && !allowedServices.includes(selectedService)) {
      return res.status(400).json({
        success: false,
        message: "Choose a valid PrimeTask service."
      });
    }

    if (
      !firstName ||
      !lastName ||
      !username ||
      !email ||
      !phone ||
      typeof password !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "Complete all required fields."
      });
    }

    if (firstName.length > 60 || lastName.length > 60) {
      return res.status(400).json({
        success: false,
        message: "Names must not exceed 60 characters."
      });
    }

    if (!/^[a-z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({
        success: false,
        message:
          "Username must contain 3–30 characters using letters, numbers, or underscores."
      });
    }

    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address."
      });
    }

    if (phone.length < 7 || phone.length > 25) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid phone number."
      });
    }

    if (password.length < 12 || password.length > 72) {
      return res.status(400).json({
        success: false,
        message: "Password must contain 12–72 characters."
      });
    }

    if (termsAccepted !== true) {
      return res.status(400).json({
        success: false,
        message: "You must accept the terms and privacy policy."
      });
    }

    let sponsor = null;

    if (sponsorUsername) {
      if (!/^[a-z0-9_]{3,30}$/.test(sponsorUsername)) {
        return res.status(400).json({
          success: false,
          message: "The sponsor username in this link is invalid."
        });
      }

      sponsor = await User.findOne({
        username: sponsorUsername,
        status: "active"
      }).select("_id username");

      if (!sponsor) {
        return res.status(400).json({
          success: false,
          message: "That sponsor username does not belong to an active account."
        });
      }
    }

    const existingUser = await User.findOne({
      $or: [{ email }, { username }]
    }).lean();

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "That email or username is already registered."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await User.create({
      firstName,
      lastName,
      username,
      email,
      phone,
      passwordHash,
      selectedService: selectedService || null,
      referredBy: sponsor ? sponsor._id : null
    });

    return res.status(201).json({
      success: true,
      message: "Your account has been created. You can now sign in.",
      user: publicUser(user)
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "That email or username is already registered."
      });
    }

    if (error.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: "Some registration details are invalid."
      });
    }

    console.error("Registration error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Registration failed. Please try again later."
    });
  }
});

/*
 * POST /api/auth/login
 */
router.post("/login", async (req, res) => {
  try {
    const identifier = normalizeText(req.body.identifier).toLowerCase();
    const password = req.body.password;
    const remember = req.body.remember === true;

    if (
      !identifier ||
      typeof password !== "string" ||
      password.length > 72
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter your username or email and password."
      });
    }

    const user = await User.findOne({
      $or: [
        { email: identifier },
        { username: identifier }
      ]
    }).select("+passwordHash");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid login details."
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      user.passwordHash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "Invalid login details."
      });
    }

    if (user.status !== "active") {
      const message = user.status === "suspended"
        ? "This account has been suspended."
        : "This account is inactive and requires activation.";

      return res.status(403).json({
        success: false,
        message
      });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = createToken(user);

    setSessionCookie(res, token, remember);

    return res.json({
      success: true,
      message: "Login successful.",
      user: publicUser(user),
      redirectUrl: "/dashboard/index.html"
    });
  } catch (error) {
    console.error("Login error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Login failed. Please try again later."
    });
  }
});

/*
 * POST /api/auth/logout
 */
router.post("/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    path: "/"
  });

  return res.json({
    success: true,
    message: "You have been signed out."
  });
});

/*
 * GET /api/auth/me
 */
router.get("/me", async (req, res) => {
  try {
    const token = req.cookies[COOKIE_NAME];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "You are not signed in."
      });
    }

    let payload;

    try {
      payload = jwt.verify(token, process.env.JWT_SECRET, {
        issuer: "primetask-workspace",
        audience: "primetask-workspace-users"
      });
    } catch {
      res.clearCookie(COOKIE_NAME, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        path: "/"
      });

      return res.status(401).json({
        success: false,
        message: "Your session has expired. Please sign in again."
      });
    }

    const user = await User.findById(payload.sub);

    if (
      !user ||
      user.status !== "active" ||
      Number(payload.sv || 0) !== Number(user.sessionVersion || 0)
    ) {
      return res.status(401).json({
        success: false,
        message: "Your account is unavailable."
      });
    }

    return res.json({
      success: true,
      user: publicUser(user)
    });
  } catch (error) {
    console.error("Session check error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to verify your session."
    });
  }
});

module.exports = router;
