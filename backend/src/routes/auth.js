const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const User = require("../models/User");
const PlatformSetting = require("../models/PlatformSetting");

const router = express.Router();

const COOKIE_NAME = "ptw_session";
const TOKEN_LIFETIME = "1d";

function createToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      role: user.role
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
    role: user.role,
    status: user.status,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

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

    if (!user || user.status !== "active") {
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
