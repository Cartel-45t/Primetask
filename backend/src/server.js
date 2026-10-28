require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/auth");
const profileRoutes = require("./routes/profile");
const chatRoutes = require("./routes/chat");
const notificationsRoutes = require("./routes/notifications");
const marketingWalletRoutes = require("./routes/marketingWallet");
const walletRoutes = require("./routes/wallet");
const withdrawalRoutes = require("./routes/withdrawals");
const referralRoutes = require("./routes/referrals");
const depositRoutes = require("./routes/deposits");
const { startDepositRecoveryWorker } = require("./services/depositRecoveryWorker");
const { startTranscriptionMinuteRecoveryWorker } = require("./services/transcriptionMinuteRecoveryWorker");
const {
  startTranscriptionJobRotationWorker,
  stopTranscriptionJobRotationWorker
} = require("./services/transcriptionJobRotationWorker");
const depositDiagnosticsRoutes = require("./routes/depositDiagnostics");
const darajaCallbackRoutes = require("./routes/darajaCallbacks");
const darajaB2CCallbackRoutes = require("./routes/darajaB2CCallbacks");
const membershipRoutes = require("./routes/membership");
const adminMembershipPlanRoutes = require("./routes/adminMembershipPlans");
const adminMembershipReconciliationRoutes = require("./routes/adminMembershipReconciliation");
const adminOverviewRoutes = require("./routes/adminOverview");
const adminMembershipFulfilmentRoutes = require("./routes/adminMembershipFulfilment");
const adminUsersRoutes = require("./routes/adminUsers");
const adminSettingsRoutes = require("./routes/adminSettings");
const adminRevenueRoutes = require("./routes/adminRevenue");
const transcriptionRoutes = require("./routes/transcription");
const adminTranscriptionRoutes = require("./routes/adminTranscription");
const TranscriptionSettings = require("./models/TranscriptionSettings");
const adminTranscriptionConfigRoutes = require("./routes/adminTranscriptionConfig");
const transcriptionWalletRoutes = require("./routes/transcriptionWallet");
const transcriptionMinutePurchasesRoutes = require("./routes/transcriptionMinutePurchases");
const adminTranscriptionMinuteReconciliationRoutes = require("./routes/adminTranscriptionMinuteReconciliation");
const transcriptionAssetsRoutes = require("./routes/transcriptionAssets");

const app = express();

const PORT = Number(process.env.PORT) || 5001;

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error("Startup blocked: JWT_SECRET must contain at least 32 characters.");
  process.exit(1);
}

if (!process.env.MONGODB_URI) {
  console.error("Startup blocked: MONGODB_URI is not configured.");
  process.exit(1);
}

app.set("trust proxy", 1);

app.disable("x-powered-by");

app.use(helmet());

app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || "http://127.0.0.1:8080",
    credentials: true
  })
);

app.use(express.json({ limit: "250kb" }));
app.use(cookieParser());

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "PrimeTask Workspace API",
    status: "running",
    timestamp: new Date().toISOString()
  });
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many authentication requests. Try again later."
  }
});

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/marketing-wallet", marketingWalletRoutes);
app.use("/api/transcription/wallet", transcriptionWalletRoutes);
app.use("/api/notes/wallet", require("./routes/notesWallet"));
app.use("/api/notes/dashboard", require("./routes/notesDashboard"));
app.use("/api/notes/tasks", require("./routes/notesTasks"));
app.use("/api/admin/notes/tasks", require("./routes/adminNotesTasks"));
app.use("/api/admin/notes/submissions", require("./routes/adminNotesSubmissions"));
app.use("/api/transcription/minute-purchases", transcriptionMinutePurchasesRoutes);
app.use("/api/admin/transcription/minute-purchases/reconciliation", adminTranscriptionMinuteReconciliationRoutes);
app.use("/api/admin/transcription/assets", transcriptionAssetsRoutes);
app.use("/api/admin/transcription", adminTranscriptionRoutes);
app.use("/api/admin/transcription/config", adminTranscriptionConfigRoutes);
app.use("/api/transcription", transcriptionRoutes);
app.use("/api/daraja/callback", darajaCallbackRoutes);
app.use("/api/daraja/callback/b2c", darajaB2CCallbackRoutes);
app.use("/api/wallet/deposits", depositDiagnosticsRoutes);
app.use("/api/wallet/deposits", depositRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/wallet/withdrawals", withdrawalRoutes);
app.use("/api/referrals", referralRoutes);
app.use("/api/membership", membershipRoutes);
app.use("/api/admin/membership-plans", adminMembershipPlanRoutes);
app.use("/api/admin/membership-reconciliation", adminMembershipReconciliationRoutes);
app.use("/api/admin/membership-fulfilment", adminMembershipFulfilmentRoutes);
app.use("/api/admin/overview", adminOverviewRoutes);
app.use("/api/admin/users", adminUsersRoutes);
app.use("/api/admin/settings", adminSettingsRoutes);
app.use("/api/admin/revenue", adminRevenueRoutes);
app.use("/api/admin/reports", require("./routes/adminNetworkReports"));

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API route not found."
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  // Invalid JSON sent by a client.
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON request body."
    });
  }

  // Request body exceeds the configured JSON size limit.
  if (error.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      message: "Request payload is too large."
    });
  }

  // Invalid database identifiers or document validation.
  if (error.name === "CastError") {
    return res.status(400).json({
      success: false,
      message: "A supplied identifier is invalid."
    });
  }

  if (error.name === "ValidationError") {
    return res.status(400).json({
      success: false,
      message: "The supplied data failed validation."
    });
  }

  // A unique database field already exists.
  if (error.code === 11000) {
    return res.status(409).json({
      success: false,
      message: "A record with these details already exists."
    });
  }

  console.error("Unhandled server error:", {
    method: req.method,
    path: req.path,
    name: error.name || "Error",
    message: error.message || "Unknown error"
  });

  return res.status(500).json({
    success: false,
    message: "An unexpected server error occurred."
  });
});

let httpServer = null;

async function startServer() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000
    });

    console.log("MongoDB connected successfully.");

    startDepositRecoveryWorker();
    startTranscriptionMinuteRecoveryWorker();

    const rotationSettings = await TranscriptionSettings.findOne({
      key: "transcription"
    }).select("rotationWorkerEnabled").lean();

    if (rotationSettings?.rotationWorkerEnabled === false) {
      console.log("Transcription job rotation worker is disabled by admin setting.");
    } else {
      startTranscriptionJobRotationWorker();
    }

    httpServer = app.listen(PORT, "0.0.0.0", () => {
      console.log(`PrimeTask Workspace API running on port ${PORT}.`);
      console.log(`Health endpoint: http://127.0.0.1:${PORT}/api/health`);
    });
  } catch (error) {
    console.error("Unable to connect to MongoDB:", error.message);
    process.exit(1);
  }
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`${signal} received. Shutting down gracefully.`);

  const forceExit = setTimeout(() => {
    console.error("Graceful shutdown timed out.");
    process.exit(1);
  }, 10000);

  forceExit.unref();

  try {
    await stopTranscriptionJobRotationWorker();

    if (httpServer) {
      await new Promise((resolve, reject) => {
        httpServer.close(error => {
          if (error) reject(error);
          else resolve();
        });
      });
    }

    await mongoose.disconnect();
    clearTimeout(forceExit);
    console.log("HTTP server closed and MongoDB disconnected.");
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    console.error("Error during graceful shutdown:", error.message);
    process.exit(1);
  }
}

let isShuttingDown = false;

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

startServer();
