require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { recordSecurityEvent } = require("./services/securityEventChainService");

const authRoutes = require("./routes/auth");
const profileRoutes = require("./routes/profile");
const chatRoutes = require("./routes/chat");
const notificationsRoutes = require("./routes/notifications");
const marketingWalletRoutes = require("./routes/marketingWallet");
const walletRoutes = require("./routes/wallet");
const withdrawalRoutes = require("./routes/withdrawals");
const referralRoutes = require("./routes/referrals");
const depositRoutes = require("./routes/deposits");
const {
  startDepositRecoveryWorker,
  stopDepositRecoveryWorker
} = require("./services/depositRecoveryWorker");
const {
  startTranscriptionMinuteRecoveryWorker,
  stopTranscriptionMinuteRecoveryWorker
} = require("./services/transcriptionMinuteRecoveryWorker");
const {
  startMembershipRecoveryWorker,
  stopMembershipRecoveryWorker
} = require("./services/membershipRecoveryWorker");
const {
  startNotesPointsRecoveryWorker,
  stopNotesPointsRecoveryWorker
} = require("./services/notesPointsRecoveryWorker");
const {
  startDataEntryBidRecoveryWorker,
  stopDataEntryBidRecoveryWorker
} = require("./services/dataEntryBidRecoveryWorker");
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
const notesWalletRoutes = require("./routes/notesWallet");
const notesPointsTransactionsRoutes = require("./routes/notesPointsTransactions");
const notesWithdrawalsRoutes = require("./routes/notesWithdrawals");
const notesDashboardRoutes = require("./routes/notesDashboard");
const notesTasksRoutes = require("./routes/notesTasks");
const dataEntryRoutes = require("./routes/dataEntry");
const dataEntryBidPurchasesRoutes = require("./routes/dataEntryBidPurchases");
const notesPointsPurchasesRoutes = require("./routes/notesPointsPurchases");
const adminNotesTasksRoutes = require("./routes/adminNotesTasks");
const adminNotesAssetsRoutes = require("./routes/adminNotesAssets");
const adminNotesSubmissionsRoutes = require("./routes/adminNotesSubmissions");
const adminNotesPointsPackagesRoutes = require("./routes/adminNotesPointsPackages");
const adminDataEntryBidPackagesRoutes = require("./routes/adminDataEntryBidPackages");
const adminDataEntryRoutes = require("./routes/adminDataEntry");
const testimonialsRoutes = require("./routes/testimonials");
const adminTestimonialsRoutes = require("./routes/adminTestimonials");
const adminSecurityRoutes = require("./routes/adminSecurity");
const adminApiRequestsRoutes = require("./routes/adminApiRequests");

const apiRequestMonitor = require("./middleware/apiRequestMonitor");

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
app.use(apiRequestMonitor);

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
  },
  handler: async (req, res) => {
    try {
      await recordSecurityEvent({
        eventType: "rate_limit_triggered",
        severity: "warning",
        outcome: "denied",
        ipAddress: req.ip || null,
        userAgent: String(req.get("user-agent") || "").slice(0, 1000) || null,
        method: req.method,
        path: String(req.path || "").split("?")[0].slice(0, 500),
        statusCode: 429,
        requestId: req.id || null,
        message: "Authentication API rate limit exceeded."
      });
    } catch (error) {
      console.error("Global authentication rate-limit event recording failed:", {
        name: error?.name,
        code: error?.code,
        message: error?.message
      });
    }

    return res.status(429).json({
      success: false,
      message: "Too many authentication requests. Try again later."
    });
  }
});

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/marketing-wallet", marketingWalletRoutes);
app.use("/api/transcription/wallet", transcriptionWalletRoutes);
app.use("/api/transcription/minute-purchases", transcriptionMinutePurchasesRoutes);
app.use("/api/notes/wallet", notesWalletRoutes);
app.use("/api/notes/points-transactions", notesPointsTransactionsRoutes);
app.use("/api/notes/withdrawals", notesWithdrawalsRoutes);
app.use("/api/notes/dashboard", notesDashboardRoutes);
app.use("/api/notes/tasks", notesTasksRoutes);
app.use("/api/data-entry", dataEntryRoutes);
app.use("/api/data-entry/bid-purchases", dataEntryBidPurchasesRoutes);
app.use("/api/notes/points-purchases", notesPointsPurchasesRoutes);
app.use("/api/admin/notes/assets", adminNotesAssetsRoutes);
app.use("/api/admin/notes/tasks", adminNotesTasksRoutes);
app.use("/api/admin/notes/submissions", adminNotesSubmissionsRoutes);
app.use("/api/admin/notes/points-packages", adminNotesPointsPackagesRoutes);
app.use("/api/admin/data-entry", adminDataEntryRoutes);
app.use("/api/admin/data-entry/bid-packages", adminDataEntryBidPackagesRoutes);
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
app.use("/api/testimonials", testimonialsRoutes);
app.use("/api/admin/testimonials", adminTestimonialsRoutes);
app.use("/api/admin/security", adminSecurityRoutes);
app.use("/api/admin/api-requests", adminApiRequestsRoutes);

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
    startMembershipRecoveryWorker();
    startNotesPointsRecoveryWorker();
    startDataEntryBidRecoveryWorker();

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
    stopDepositRecoveryWorker();
    stopTranscriptionMinuteRecoveryWorker();
    stopMembershipRecoveryWorker();
    stopNotesPointsRecoveryWorker();
    stopDataEntryBidRecoveryWorker();

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
