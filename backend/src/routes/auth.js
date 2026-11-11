const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");
const rateLimit = require("express-rate-limit");

const User = require("../models/User");
const EmailVerification = require("../models/EmailVerification");
const EmailVerificationThrottle = require("../models/EmailVerificationThrottle");
const passwordResetEmailService = require("../services/passwordResetEmailService");
const emailVerificationService = require("../services/emailVerificationService");
const PlatformSetting = require("../models/PlatformSetting");
const securityEventChainService = require("../services/securityEventChainService");
const deviceAccessService = require("../services/deviceAccessService");
const requireAuth = require("../middleware/requireAuth");

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

async function recordAuthSecurityEvent(req, event) {
  try {
    await securityEventChainService.recordSecurityEvent({
      ...event,
      ipAddress: req.ip || null,
      userAgent: String(req.get("user-agent") || "").slice(0, 1000) || null,
      method: req.method,
      path: String(req.path || "").split("?")[0].slice(0, 500),
      requestId: req.id || null
    });

    return true;
  } catch (error) {
    // Diagnostic details stay in server logs and are never sent to clients.
    console.error("Authentication security event recording failed:", {
      name: error?.name,
      code: error?.code,
      message: error?.message
    });
    return false;
  }
}

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many password reset requests. Try again later."
  },
  handler: async (req, res, next, options) => {
    await recordAuthSecurityEvent(req, {
      eventType: "rate_limit_triggered",
      severity: "warning",
      outcome: "denied",
      message: "Password reset request rate limit exceeded."
    });

    return res.status(options.statusCode).json(options.message);
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
  },
  handler: async (req, res, next, options) => {
    await recordAuthSecurityEvent(req, {
      eventType: "rate_limit_triggered",
      severity: "warning",
      outcome: "denied",
      message: "Password reset attempt rate limit exceeded."
    });

    return res.status(options.statusCode).json(options.message);
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
      await recordAuthSecurityEvent(req, {
        eventType: "password_reset_requested",
        severity: "info",
        outcome: "pending",
        message: "Password reset requested for an unrecognized account."
      });

      return res.status(200).json(PASSWORD_RESET_RESPONSE);
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    user.passwordResetTokenHash = tokenHash;
    user.passwordResetExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();

    let emailDelivered = true;

    try {
      await passwordResetEmailService.sendPasswordResetEmail({
        email: user.email,
        firstName: user.firstName,
        token: rawToken
      });
    } catch (emailError) {
      emailDelivered = false;
      user.passwordResetTokenHash = null;
      user.passwordResetExpiresAt = null;
      await user.save().catch(() => {});
      console.error("Password reset email delivery failed.");
    }

    await recordAuthSecurityEvent(req, {
      eventType: "password_reset_requested",
      severity: emailDelivered ? "info" : "warning",
      outcome: emailDelivered ? "success" : "failed",
      userId: user._id,
      message: emailDelivered
        ? "Password reset instructions sent."
        : "Password reset email delivery failed."
    });

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
    password.length < 6 ||
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

    await recordAuthSecurityEvent(req, {
      eventType: "password_reset_completed",
      severity: "warning",
      outcome: "success",
      userId: updatedUser._id,
      message: "Password reset completed successfully."
    });

    await recordAuthSecurityEvent(req, {
      eventType: "session_revoked",
      severity: "info",
      outcome: "success",
      userId: updatedUser._id,
      message: "Existing sessions invalidated after password reset."
    });

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
 * POST /api/auth/verify-email
 */
router.post(
  "/verify-email",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false
  }),
  async (req, res) => {
    try {
      const email = normalizeText(req.body?.email).toLowerCase();
      const code = normalizeText(req.body?.code || req.body?.otp);

      if (
        !email ||
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !/^\d{6}$/.test(code)
      ) {
        return res.status(400).json({
          success: false,
          message: "Enter a valid email address and six-digit verification code."
        });
      }

      const user = await User.findOne({ email });

      if (!user || user.emailVerificationRequired !== true) {
        return res.status(400).json({
          success: false,
          message: "The verification request is invalid or has expired."
        });
      }

      if (user.emailVerified === true) {
        return res.status(400).json({
          success: false,
          message: "This email address is already verified. The code cannot be reused."
        });
      }

      const verification = await EmailVerification.findOne({
        userId: user._id,
        email
      }).select("+codeHash +pendingCodeHash");

      const now = new Date();

      if (!verification) {
        return res.status(400).json({
          success: false,
          message: "The verification code is invalid or expired. Request a new code."
        });
      }

      if (verification.attempts >= emailVerificationService.MAX_ATTEMPTS) {
        return res.status(429).json({
          success: false,
          message: "Too many incorrect attempts. Request a new verification code."
        });
      }

      const activeCodeExpiry =
        verification.activeExpiresAt || verification.expiresAt;

      const activeCodeValid =
        activeCodeExpiry > now &&
        emailVerificationService.verifyCodeHash({
          userId: user._id,
          email,
          code,
          storedHash: verification.codeHash
        });

      const pendingCodeValid =
        Boolean(verification.pendingCodeHash) &&
        Boolean(verification.pendingExpiresAt) &&
        verification.pendingExpiresAt > now &&
        emailVerificationService.verifyCodeHash({
          userId: user._id,
          email,
          code,
          storedHash: verification.pendingCodeHash
        });

      if (!activeCodeValid && !pendingCodeValid) {
        await EmailVerification.updateOne(
          {
            _id: verification._id,
            attempts: { $lt: emailVerificationService.MAX_ATTEMPTS }
          },
          { $inc: { attempts: 1 } }
        );

        return res.status(400).json({
          success: false,
          message: "The verification code is incorrect."
        });
      }

      const matchedCodeFilter = pendingCodeValid
        ? {
            pendingCodeHash: verification.pendingCodeHash,
            pendingExpiresAt: { $gt: now }
          }
        : {
            codeHash: verification.codeHash,
            $or: [
              { activeExpiresAt: { $gt: now } },
              {
                activeExpiresAt: { $exists: false },
                expiresAt: { $gt: now }
              }
            ]
          };

      const session = await User.db.startSession();
      try {
        await session.withTransaction(async () => {
          const consumed = await EmailVerification.findOneAndDelete({
            _id: verification._id,
            userId: user._id,
            email,
            ...matchedCodeFilter,
            attempts: { $lt: emailVerificationService.MAX_ATTEMPTS }
          }).session(session);

          if (!consumed) {
            const error = new Error("Verification record expired or was already consumed.");
            error.code = "OTP_RECORD_UNAVAILABLE";
            throw error;
          }

          const updatedUser = await User.findOneAndUpdate(
            {
              _id: user._id,
              email: verification.email,
              emailVerificationRequired: true,
              emailVerified: false
            },
            { $set: { emailVerified: true } },
            {
              returnDocument: "after",
              runValidators: true,
              session
            }
          );

          if (!updatedUser) {
            const error = new Error("Account is no longer eligible for verification.");
            error.code = "ACCOUNT_NOT_VERIFIABLE";
            throw error;
          }
        });
      } catch (error) {
        if (error.code === "OTP_RECORD_UNAVAILABLE") {
          return res.status(400).json({
            success: false,
            message: "The verification code is invalid or expired. Request a new code."
          });
        }

        if (error.code === "ACCOUNT_NOT_VERIFIABLE") {
          return res.status(409).json({
            success: false,
            message: "Unable to complete email verification. The account may already be verified."
          });
        }

        throw error;
      } finally {
        await session.endSession();
      }

      await recordAuthSecurityEvent(req, {
        eventType: "email_verified",
        severity: "info",
        outcome: "success",
        userId: user._id,
        message: "Registration email address verified."
      });

      return res.status(200).json({
        success: true,
        message: "Email verified successfully. You can now sign in."
      });
    } catch (error) {
      console.error("Email verification failed:", error.message);
      return res.status(500).json({
        success: false,
        message: "Unable to verify your email right now. Please try again."
      });
    }
  }
);

/*
 * POST /api/auth/resend-verification
 */
router.post(
  "/resend-verification",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: "draft-8",
    legacyHeaders: false
  }),
  async (req, res) => {
    const genericResponse = {
      success: true,
      message: "If the account requires verification, a new code will be sent when eligible."
    };

    try {
      const email = normalizeText(req.body?.email).toLowerCase();

      if (
        !email ||
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ) {
        return res.status(200).json(genericResponse);
      }

      const user = await User.findOne({
        email,
        emailVerificationRequired: true,
        emailVerified: false
      });

      if (!user) return res.status(200).json(genericResponse);

      const now = new Date();
      const cooldownCutoff = new Date(
        now.getTime() - emailVerificationService.RESEND_COOLDOWN_MS
      );
      const windowCutoff = new Date(
        now.getTime() - emailVerificationService.RESEND_WINDOW_MS
      );

      try {
        await EmailVerificationThrottle.findOneAndUpdate(
          { userId: user._id },
          {
            $setOnInsert: {
              windowStartedAt: now,
              resendCount: 0,
              lastSentAt: new Date(0)
            }
          },
          {
            upsert: true,
            returnDocument: "after",
            runValidators: true
          }
        );
      } catch (seedError) {
        if (seedError.code !== 11000) throw seedError;
      }

      const reservation = await EmailVerificationThrottle.findOneAndUpdate(
        {
          userId: user._id,
          $expr: {
            $and: [
              { $lte: ["$lastSentAt", cooldownCutoff] },
              {
                $or: [
                  { $lte: ["$windowStartedAt", windowCutoff] },
                  {
                    $lt: [
                      "$resendCount",
                      emailVerificationService.MAX_RESENDS_PER_WINDOW
                    ]
                  }
                ]
              }
            ]
          }
        },
        [
          {
            $set: {
              windowStartedAt: {
                $cond: [
                  { $lte: ["$windowStartedAt", windowCutoff] },
                  now,
                  "$windowStartedAt"
                ]
              },
              resendCount: {
                $cond: [
                  { $lte: ["$windowStartedAt", windowCutoff] },
                  1,
                  { $add: [{ $ifNull: ["$resendCount", 0] }, 1] }
                ]
              },
              lastSentAt: now
            }
          }
        ],
        { returnDocument: "after" }
      );

      if (!reservation) return res.status(200).json(genericResponse);

      const previousVerification = await EmailVerification.findOne({
        userId: user._id
      }).select("_id expiresAt activeExpiresAt").lean();

      const code = emailVerificationService.generateVerificationCode();
      const codeHash = emailVerificationService.hashVerificationCode({
        userId: user._id,
        email: user.email,
        code
      });
      const expiresAt = new Date(
        now.getTime() + emailVerificationService.OTP_LIFETIME_MS
      );

      const verification = await EmailVerification.findOneAndUpdate(
        { userId: user._id },
        {
          $set: {
            email: user.email,
            pendingCodeHash: codeHash,
            pendingExpiresAt: expiresAt,
            expiresAt,
            ...(previousVerification
              ? {
                  activeExpiresAt:
                    previousVerification.activeExpiresAt ||
                    previousVerification.expiresAt
                }
              : {})
          },
          $setOnInsert: {
            codeHash,
            attempts: 0,
            sentAt: now,
            resendWindowStartedAt: now,
            resendCount: 0
          }
        },
        {
          upsert: true,
          returnDocument: "after",
          runValidators: true,
          setDefaultsOnInsert: true
        }
      );

      try {
        await emailVerificationService.sendVerificationEmail({
          email: user.email,
          firstName: user.firstName,
          code
        });
      } catch (emailError) {
        if (previousVerification) {
          await EmailVerification.updateOne(
            {
              _id: verification._id,
              pendingCodeHash: codeHash
            },
            {
              $set: {
                expiresAt:
                  previousVerification.activeExpiresAt ||
                  previousVerification.expiresAt
              },
              $unset: {
                pendingCodeHash: 1,
                pendingExpiresAt: 1,
                activeExpiresAt: 1
              }
            }
          ).catch(() => {});
        } else {
          await EmailVerification.deleteOne({
            _id: verification._id,
            pendingCodeHash: codeHash
          }).catch(() => {});
        }

        await EmailVerificationThrottle.updateOne(
          { userId: user._id },
          { $set: { lastSentAt: new Date(0) } }
        ).catch(() => {});

        console.error("Verification resend delivery failed:", {
          name: emailError?.name,
          message: emailError?.message
        });

        return res.status(200).json(genericResponse);
      }

      const promoted = await EmailVerification.findOneAndUpdate(
        {
          _id: verification._id,
          pendingCodeHash: codeHash,
          pendingExpiresAt: expiresAt
        },
        {
          $set: {
            codeHash,
            expiresAt,
            attempts: 0,
            sentAt: now
          },
          $unset: {
            pendingCodeHash: 1,
            pendingExpiresAt: 1,
            activeExpiresAt: 1
          }
        },
        {
          returnDocument: "after",
          runValidators: true
        }
      );

      if (!promoted) {
        console.error(
          "Verification email was delivered but pending OTP promotion did not complete."
        );
      }

      await recordAuthSecurityEvent(req, {
        eventType: "email_verification_sent",
        severity: "info",
        outcome: "success",
        userId: user._id,
        message: "Registration verification code resent."
      });

      return res.status(200).json(genericResponse);
    } catch (error) {
      console.error("Verification resend failed:", error.message);
      return res.status(200).json(genericResponse);
    }
  }
);

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

    if (password.length < 6 || password.length > 72) {
      return res.status(400).json({
        success: false,
        message: "Password must contain 6–72 characters."
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
      emailVerificationRequired: true,
      emailVerified: false,
      selectedService: selectedService || null,
      referredBy: sponsor ? sponsor._id : null
    });

    const verificationCode =
      emailVerificationService.generateVerificationCode();
    const now = new Date();

    await EmailVerification.findOneAndUpdate(
      { userId: user._id },
      {
        $set: {
          email: user.email,
          codeHash: emailVerificationService.hashVerificationCode({
            userId: user._id,
            email: user.email,
            code: verificationCode
          }),
          expiresAt: new Date(
            now.getTime() + emailVerificationService.OTP_LIFETIME_MS
          ),
          attempts: 0,
          sentAt: now,
          resendWindowStartedAt: now,
          resendCount: 0
        }
      },
      { upsert: true, new: true, runValidators: true }
    );

    await EmailVerificationThrottle.findOneAndUpdate(
      { userId: user._id },
      {
        $setOnInsert: {
          windowStartedAt: now,
          resendCount: 0,
          lastSentAt: now
        }
      },
      { upsert: true, returnDocument: "after", runValidators: true }
    );

    try {
      await emailVerificationService.sendVerificationEmail({
        email: user.email,
        firstName: user.firstName,
        code: verificationCode
      });
    } catch (emailError) {
      await EmailVerificationThrottle.updateOne(
        { userId: user._id },
        { $set: { lastSentAt: new Date(0) } }
      ).catch((throttleError) => {
        console.error("Unable to release initial verification cooldown:", throttleError.message);
      });

      console.error("Registration verification email delivery failed:", {
        name: emailError?.name,
        message: emailError?.message
      });

      return res.status(503).json({
        success: false,
        code: "VERIFICATION_EMAIL_FAILED",
        email: user.email,
        message: "Your account was created, but the verification email could not be delivered. Request a new code to try again."
      });
    }

    await recordAuthSecurityEvent(req, {
      eventType: "email_verification_sent",
      severity: "info",
      outcome: "success",
      userId: user._id,
      message: "Registration verification code sent."
    });

    return res.status(201).json({
      success: true,
      verificationRequired: true,
      email: user.email,
      message: "Account created. Enter the verification code sent to your email.",
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
      await recordAuthSecurityEvent(req, {
        eventType: "login_failed",
        severity: "warning",
        outcome: "denied",
        message: "Login rejected."
      });

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
      await recordAuthSecurityEvent(req, {
        eventType: "login_failed",
        severity: "warning",
        outcome: "denied",
        userId: user._id,
        message: "Login rejected."
      });

      return res.status(401).json({
        success: false,
        message: "Invalid login details."
      });
    }

    if (user.status !== "active") {
      const message = user.status === "suspended"
        ? "This account has been suspended."
        : "This account is inactive and requires activation.";

      await recordAuthSecurityEvent(req, {
        eventType: "login_failed",
        severity: "warning",
        outcome: "denied",
        userId: user._id,
        message: "Login rejected because the account is not active."
      });

      return res.status(403).json({
        success: false,
        message
      });
    }

      if (
        user.emailVerificationRequired === true &&
        user.emailVerified !== true
      ) {
        await recordAuthSecurityEvent(req, {
          eventType: "login_failed",
          severity: "warning",
          outcome: "denied",
          userId: user._id,
          message: "Login rejected because registration email is not verified."
        });

        return res.status(403).json({
          success: false,
          code: "EMAIL_NOT_VERIFIED",
          message: "Verify your email address before signing in.",
          verificationUrl: "/auth/verify-email.html"
        });
      }


    let deviceAccess;

    try {
      deviceAccess = await deviceAccessService.authorizeLoginDevice(
        req,
        res,
        user
      );
    } catch (deviceError) {
      console.error("Device authorization failed:", {
        name: deviceError?.name,
        code: deviceError?.code,
        message: deviceError?.message
      });
      return res.status(503).json({
        success: false,
        message: "Device security verification is temporarily unavailable."
      });
    }

    if (!deviceAccess.allowed) {
      return res.status(deviceAccess.status || 403).json({
        success: false,
        code: deviceAccess.code || "DEVICE_ACCESS_DENIED",
        message: deviceAccess.message || "This browser is not authorized."
      });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const eventRecorded = await recordAuthSecurityEvent(req, {
      eventType: "login_success",
      severity: "info",
      outcome: "success",
      userId: user._id,
      message: "User login successful."
    });

    if (!eventRecorded) {
      return res.status(503).json({
        success: false,
        message: "Sign-in is temporarily unavailable. Please try again."
      });
    }

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
router.post("/logout", async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];

  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET, {
        issuer: "primetask-workspace",
        audience: "primetask-workspace-users"
      });

      await recordAuthSecurityEvent(req, {
        eventType: "logout",
        severity: "info",
        outcome: "success",
        userId: payload.sub,
        message: "User signed out."
      });
    } catch {
      // Invalid or expired sessions must still be cleared.
    }
  }

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
router.get("/me", requireAuth, async (req, res) => {
  try {
    return res.json({
      success: true,
      user: publicUser(req.user)
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
