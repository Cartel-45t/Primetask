const express = require("express");
const mongoose = require("mongoose");
const { randomInt, randomUUID } = require("crypto");

const Withdrawal = require("../models/Withdrawal");
const PlatformSetting = require("../models/PlatformSetting");
const MpesaReceiptClaim = require("../models/MpesaReceiptClaim");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const AdminAuditLog = require("../models/AdminAuditLog");
const requireAuth = require("../middleware/requireAuth");
const { initiateB2CPayment } = require("../services/darajaB2CService");

const router = express.Router();
router.use(requireAuth);

const MIN_CENTS = Number(
  process.env.WALLET_WITHDRAWAL_MIN_USD_CENTS || 785
);
const MAX_CENTS = Number(
  process.env.WALLET_WITHDRAWAL_MAX_USD_CENTS || 50000
);

function centsToUSD(cents) {
  return Number((cents / 100).toFixed(2));
}

function generateWithdrawalReference() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let suffix = "";

  for (let i = 0; i < 8; i += 1) {
    suffix += alphabet[randomInt(alphabet.length)];
  }

  return `PTW-WC${suffix}`;
}

function isAdmin(req) {
  return ["admin", "founder"].includes(req.user.role);
}

function normalizeKenyanPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");

  if (/^0[17]\d{8}$/.test(digits)) {
    return `254${digits.slice(1)}`;
  }

  if (/^[17]\d{8}$/.test(digits)) {
    return `254${digits}`;
  }

  if (/^254[17]\d{8}$/.test(digits)) {
    return digits;
  }

  return null;
}

function parseAmountCents(value) {
  const amount = String(value ?? "").trim();

  if (!/^\d{1,7}(\.\d{1,2})?$/.test(amount)) {
    return null;
  }

  const [whole, fraction = ""] = amount.split(".");
  const cents =
    Number(whole) * 100 + Number(fraction.padEnd(2, "0"));

  return Number.isSafeInteger(cents) ? cents : null;
}

function validWithdrawalConfig() {
  return (
    Number.isSafeInteger(MIN_CENTS) &&
    Number.isSafeInteger(MAX_CENTS) &&
    MIN_CENTS > 0 &&
    MAX_CENTS >= MIN_CENTS
  );
}

function sendServerError(res, message) {
  return res.status(500).json({
    success: false,
    message
  });
}

/*
 * POST /api/wallet/withdrawals
 * Body: { "amount": "5.00", "phoneNumber": "0712345678" }
 *
 * Reserves funds and creates the withdrawal ledger entry atomically.
 * No M-Pesa payment is initiated by this endpoint.
 */
router.post("/", async (req, res) => {
  if (!validWithdrawalConfig()) {
    console.error("Invalid wallet withdrawal minimum/maximum configuration.");
    return sendServerError(
      res,
      "Withdrawal service configuration is invalid."
    );
  }

  const amountCents = parseAmountCents(req.body?.amount);
  const phoneNumber = normalizeKenyanPhone(req.body?.phoneNumber);

  if (
    amountCents === null ||
    amountCents < MIN_CENTS ||
    amountCents > MAX_CENTS
  ) {
    return res.status(400).json({
      success: false,
      message:
        `Enter a withdrawal between $${centsToUSD(MIN_CENTS).toFixed(2)} ` +
        `and $${centsToUSD(MAX_CENTS).toFixed(2)} USD.`
    });
  }

  if (!phoneNumber) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid Kenyan M-Pesa phone number."
    });
  }

  let platformSettings;
  try {
    platformSettings = await PlatformSetting.findOne({ key: "platform" }).lean();
  } catch (error) {
    console.error("Withdrawal exchange-rate lookup failed:", error.message);
    return sendServerError(res, "Could not verify the withdrawal exchange rate.");
  }

  const exchangeRateKesPerUsd = platformSettings?.exchangeRateKesPerUsd;
  if (
    typeof exchangeRateKesPerUsd !== "number" ||
    !Number.isFinite(exchangeRateKesPerUsd) ||
    exchangeRateKesPerUsd < 1 ||
    exchangeRateKesPerUsd > 1000
  ) {
    return res.status(503).json({
      success: false,
      message: "Withdrawals are temporarily unavailable because the administrator has not configured a valid KES-per-USD exchange rate."
    });
  }

  const payoutAmountKes = Math.round(amountCents * exchangeRateKesPerUsd / 100);
  if (!Number.isSafeInteger(payoutAmountKes) || payoutAmountKes < 1) {
    return res.status(400).json({
      success: false,
      message: "The calculated M-Pesa payout amount is invalid."
    });
  }

  const requestId = `WD-${randomUUID()}`;
  let publicReference;
  const session = await mongoose.startSession();
  let result;

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      publicReference = generateWithdrawalReference();

      try {
        await session.withTransaction(async () => {
      // Reserve only funds that are actually available.
      const wallet = await Wallet.findOneAndUpdate(
        {
          userId: req.user._id,
          currency: "USD",
          availableBalanceCents: { $gte: amountCents }
        },
        {
          $inc: { availableBalanceCents: -amountCents }
        },
        {
          returnDocument: 'after',
          runValidators: true,
          session
        }
      );

      if (!wallet) {
        const error = new Error("INSUFFICIENT_BALANCE");
        error.code = "INSUFFICIENT_BALANCE";
        throw error;
      }

      const [withdrawal] = await Withdrawal.create(
        [{
          requestId,
          publicReference,
          userId: req.user._id,
          amountCents,
          currency: "USD",
          exchangeRateKesPerUsd,
          payoutAmountKes,
          phoneNumber
        }],
        { session }
      );

      const [transaction] = await WalletTransaction.create(
        [{
          userId: req.user._id,
          type: "withdrawal",
          amountCents,
          currency: "USD",
          status: "pending",
          reference: publicReference,
          description: "Withdrawal request awaiting admin review"
        }],
        { session }
      );

      withdrawal.transactionId = transaction._id;
      await withdrawal.save({ session });

      result = {
        requestId,
        publicReference,
        amount: centsToUSD(amountCents),
        currency: "USD",
        exchangeRateKesPerUsd,
        payoutAmountKes,
        phoneNumber,
        status: withdrawal.status,
        createdAt: withdrawal.createdAt,
        availableBalance: centsToUSD(wallet.availableBalanceCents)
      };
        });

        break;
      } catch (error) {
        const duplicatePublicReference =
          error.code === 11000 &&
          (
            Boolean(error.keyPattern?.publicReference) ||
            /publicReference_1/.test(error.message || "")
          );

        if (!duplicatePublicReference || attempt === 4) {
          throw error;
        }
      }
    }

    if (!result) {
      throw new Error("Withdrawal transaction completed without a result.");
    }

    return res.status(201).json({
      success: true,
      message:
        "Withdrawal request submitted for admin review. No payment has been sent yet.",
      withdrawal: {
        requestId: result.requestId,
        reference: result.publicReference,
        publicReference: result.publicReference,
        amount: result.amount,
        currency: result.currency,
        exchangeRateKesPerUsd: result.exchangeRateKesPerUsd,
        payoutAmountKes: result.payoutAmountKes,
        phoneNumber: result.phoneNumber,
        status: result.status,
        createdAt: result.createdAt
      },
      availableBalance: result.availableBalance
    });
  } catch (error) {
    if (error.code === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({
        success: false,
        message: "Insufficient available wallet balance."
      });
    }

    console.error("Withdrawal request error:", error.message);

    return sendServerError(
      res,
      "Could not create the withdrawal request. No partial database changes should have been committed."
    );
  } finally {
    await session.endSession();
  }
});

/*
 * GET /api/wallet/withdrawals/mine
 * Members can see only their own requests.
 */
router.get("/mine", async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({
      userId: req.user._id
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .select(
        "requestId publicReference amountCents currency exchangeRateKesPerUsd payoutAmountKes phoneNumber status mpesaReceipt adminNote createdAt reviewedAt"
      )
      .lean();

    return res.json({
      success: true,
      currency: "USD",
      withdrawals: withdrawals.map((item) => ({
        ...item,
        reference: item.publicReference || item.requestId,
        amount: centsToUSD(item.amountCents)
      }))
    });
  } catch (error) {
    console.error("Member withdrawal history error:", error.message);

    return sendServerError(
      res,
      "Could not load withdrawal history."
    );
  }
});

/*
 * GET /api/wallet/withdrawals/admin?status=pending_review
 */
router.get("/admin", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Admin access required."
    });
  }

  try {
    const status = String(req.query.status || "pending_review");
    const allowed = [
      "pending_review", "approved", "processing",
      "reconciliation_required", "paid", "rejected"
    ];

    if (!allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid withdrawal status filter."
      });
    }

    const withdrawals = await Withdrawal.find({ status })
      .sort({ createdAt: 1 })
      .limit(100)
      .populate("userId", "firstName lastName username email")
      .lean();

    return res.json({
      success: true,
      currency: "USD",
      withdrawals: withdrawals.map((item) => ({
        ...item,
        reference: item.publicReference || item.requestId,
        amount: centsToUSD(item.amountCents)
      }))
    });
  } catch (error) {
    console.error("Admin withdrawal queue error:", error.message);

    return sendServerError(
      res,
      "Could not load the admin withdrawal queue."
    );
  }
});


/*
 * POST /api/wallet/withdrawals/:requestId/approve
 * Approval records the decision only. It does not move money.
 */
router.post("/:requestId/approve", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Admin access required."
    });
  }

  const session = await mongoose.startSession();
  let result;

  try {
    await session.withTransaction(async () => {
      const withdrawal = await Withdrawal.findOneAndUpdate(
        {
          requestId: req.params.requestId,
          status: "pending_review"
        },
        {
          $set: {
            status: "approved",
            reviewedBy: req.user._id,
            reviewedAt: new Date(),
            adminNote: "Approved. B2C initiation requires a separate admin action."
          }
        },
        {
          returnDocument: "after",
          runValidators: true,
          session
        }
      );

      if (!withdrawal) {
        const error = new Error("WITHDRAWAL_NOT_PENDING");
        error.code = "WITHDRAWAL_NOT_PENDING";
        throw error;
      }

      if (!withdrawal.transactionId) {
        throw new Error("Withdrawal has no linked wallet transaction.");
      }

      const ledger = await WalletTransaction.findOne({
        _id: withdrawal.transactionId,
        userId: withdrawal.userId,
        type: "withdrawal",
        status: "pending"
      }).session(session);

      if (!ledger || ledger.amountCents !== withdrawal.amountCents) {
        throw new Error("Matching pending withdrawal ledger entry is missing or inconsistent.");
      }

      await AdminAuditLog.create([{
        adminId: req.user._id,
        targetUserId: withdrawal.userId,
        action: "withdrawal.approved",
        reason: "Withdrawal approved; no payout was initiated.",
        before: {
          status: "pending_review",
          amountCents: withdrawal.amountCents,
          currency: withdrawal.currency
        },
        after: {
          status: "approved",
          amountCents: withdrawal.amountCents,
          currency: withdrawal.currency,
          requestId: withdrawal.requestId
        },
        ipAddress: req.ip
      }], { session });
result = { requestId: withdrawal.requestId };
    });

    return res.json({
      success: true,
      message: "Withdrawal approved. No payment has been sent; initiate B2C separately.",
      requestId: result.requestId
    });
  } catch (error) {
    if (error.code === "WITHDRAWAL_NOT_PENDING") {
      const exists = await Withdrawal.exists({
        requestId: req.params.requestId
      });

      return res.status(exists ? 409 : 404).json({
        success: false,
        message: exists
          ? "This withdrawal has already been reviewed."
          : "Withdrawal request not found."
      });
    }

    console.error("Approve withdrawal error:", error.message);
    return sendServerError(
      res,
      "Could not approve the withdrawal. No partial transaction should have been committed."
    );
  } finally {
    await session.endSession();
  }
});


/*
 * POST /api/wallet/withdrawals/:requestId/initiate-b2c
 *
 * One explicit admin attempt per withdrawal. Persist the attempt and unique
 * originator ID before contacting Daraja. Never automatically retry.
 */
router.post("/:requestId/initiate-b2c", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Admin access required."
    });
  }

  // Do not reserve an attempt while the feature is disabled.
  if (
    process.env.DARAJA_LIVE_ENABLED !== "true" ||
    process.env.DARAJA_B2C_ENABLED !== "true"
  ) {
    return res.status(503).json({
      success: false,
      message: "Daraja B2C initiation is disabled. No attempt was started."
    });
  }

  const session = await mongoose.startSession();
  let attempt;

  try {
    await session.withTransaction(async () => {
      const withdrawal = await Withdrawal.findOne({
        requestId: req.params.requestId,
        status: "approved",
        b2cInitiationState: "not_started",
        $or: [
          { b2cOriginatorConversationId: null },
          { b2cOriginatorConversationId: { $exists: false } }
        ]
      }).session(session);

      if (!withdrawal) {
        const error = new Error("WITHDRAWAL_NOT_INITIABLE");
        error.code = "WITHDRAWAL_NOT_INITIABLE";
        throw error;
      }

      if (
        !withdrawal.transactionId ||
        !Number.isSafeInteger(withdrawal.payoutAmountKes) ||
        withdrawal.payoutAmountKes < 1 ||
        !/^254[17]\d{8}$/.test(String(withdrawal.phoneNumber || ""))
      ) {
        throw new Error("Withdrawal payout details or linked ledger are invalid.");
      }

      const ledger = await WalletTransaction.findOne({
        _id: withdrawal.transactionId,
        userId: withdrawal.userId,
        type: "withdrawal",
        status: "pending",
        amountCents: withdrawal.amountCents
      }).session(session);

      if (!ledger) {
        throw new Error("Matching pending withdrawal ledger entry is missing or inconsistent.");
      }

      const originatorConversationId = `PTWB2C_${randomUUID()}`;
      const initiatedAt = new Date();

      const claimed = await Withdrawal.updateOne(
        {
          _id: withdrawal._id,
          status: "approved",
          b2cInitiationState: "not_started",
          $or: [
            { b2cOriginatorConversationId: null },
            { b2cOriginatorConversationId: { $exists: false } }
          ]
        },
        {
          $set: {
            status: "processing",
            b2cInitiationState: "submitting",
            b2cOriginatorConversationId: originatorConversationId,
            b2cInitiatedAt: initiatedAt,
            adminNote: "B2C initiation attempted; awaiting provider confirmation."
          }
        },
        { session, runValidators: true }
      );

      if (claimed.modifiedCount !== 1) {
        const error = new Error("WITHDRAWAL_NOT_INITIABLE");
        error.code = "WITHDRAWAL_NOT_INITIABLE";
        throw error;
      }

      await AdminAuditLog.create([{
        adminId: req.user._id,
        targetUserId: withdrawal.userId,
        action: "withdrawal.b2c_initiation_started",
        reason: "Admin initiated a single B2C attempt; provider outcome is not yet confirmed.",
        before: {
          status: "approved",
          amountCents: withdrawal.amountCents,
          currency: withdrawal.currency
        },
        after: {
          status: "processing",
          amountCents: withdrawal.amountCents,
          currency: withdrawal.currency,
          payoutAmountKes: withdrawal.payoutAmountKes,
          originatorConversationId,
          requestId: withdrawal.requestId
        },
        ipAddress: req.ip
      }], { session });

      attempt = {
        requestId: withdrawal.requestId,
        userId: withdrawal.userId,
        originatorConversationId,
        phoneNumber: withdrawal.phoneNumber,
        amountKes: withdrawal.payoutAmountKes
      };
    });

    if (!attempt) {
      throw new Error("B2C initiation attempt was not persisted.");
    }
  } catch (error) {
    if (error.code === "WITHDRAWAL_NOT_INITIABLE") {
      const exists = await Withdrawal.exists({
        requestId: req.params.requestId
      });

      return res.status(exists ? 409 : 404).json({
        success: false,
        message: exists
          ? "This withdrawal is not eligible for a new B2C attempt. Check its status before taking action."
          : "Withdrawal request not found."
      });
    }

    console.error("Prepare B2C withdrawal error:", error.message);
    return sendServerError(
      res,
      "Could not safely prepare the B2C attempt. Verify the withdrawal and ledger records."
    );
  } finally {
    await session.endSession();
  }

  try {
    const providerResult = await initiateB2CPayment({
      originatorConversationId: attempt.originatorConversationId,
      phoneNumber: attempt.phoneNumber,
      amountKes: attempt.amountKes,
      remarks: `PTW withdrawal ${attempt.requestId}`,
      occasion: "Member withdrawal"
    });

    if (!providerResult.accepted) {
      // Even a provider rejection is not automatically retried. Keep the
      // withdrawal reserved and send it for explicit reconciliation.
      await Withdrawal.updateOne(
        {
          requestId: attempt.requestId,
          b2cOriginatorConversationId: attempt.originatorConversationId,
          status: "processing",
          b2cInitiationState: "submitting"
        },
        {
          $set: {
            status: "reconciliation_required",
            b2cInitiationState: "unknown",
            b2cConversationId: providerResult.conversationId || null,
            b2cResultDescription: String(
              providerResult.responseDescription ||
              providerResult.message ||
              "Provider did not confirm payment initiation."
            ).slice(0, 500),
            adminNote: "B2C outcome requires reconciliation. Do not retry automatically."
          }
        }
      );

      return res.status(202).json({
        success: false,
        reconciliationRequired: true,
        message: "The provider did not confirm initiation. The withdrawal requires reconciliation; do not retry it.",
        requestId: attempt.requestId
      });
    }

    // A callback can arrive before this response is handled. Only update
    // a still-submitting attempt; never overwrite callback success.
    await Withdrawal.updateOne(
      {
        requestId: attempt.requestId,
        b2cOriginatorConversationId: attempt.originatorConversationId,
        status: "processing",
        b2cInitiationState: "submitting"
      },
      {
        $set: {
          b2cInitiationState: "accepted",
          b2cConversationId: providerResult.conversationId || null,
          b2cResultDescription: String(
            providerResult.responseDescription || "Provider accepted the request."
          ).slice(0, 500)
        }
      }
    );

    return res.status(202).json({
      success: true,
      message: "B2C request submitted. Final payment status depends on the verified provider callback.",
      requestId: attempt.requestId
    });
  } catch (error) {
    // The request may have reached Safaricom even when our connection failed.
    // Therefore this state is deliberately non-retryable by this endpoint.
    console.error("B2C initiation outcome requires reconciliation:", error.message);

    try {
      await Withdrawal.updateOne(
        {
          requestId: attempt.requestId,
          b2cOriginatorConversationId: attempt.originatorConversationId,
          status: "processing",
          b2cInitiationState: "submitting"
        },
        {
          $set: {
            status: "reconciliation_required",
            b2cInitiationState: "unknown",
            b2cResultDescription: "Initiation outcome could not be confirmed. Manual reconciliation required.",
            adminNote: "B2C outcome unknown. Do not retry or refund until reconciled."
          }
        }
      );
    } catch (updateError) {
      console.error("Could not persist B2C reconciliation state:", updateError.message);
    }

    return res.status(202).json({
      success: false,
      reconciliationRequired: true,
      message: "The initiation outcome is unknown. Reconcile with Safaricom before any further action.",
      requestId: attempt.requestId
    });
  }
});

/*
 * POST /api/wallet/withdrawals/:requestId/paid
 * Body: { "mpesaReceipt": "RECEIPT123" }
 *
 * An admin must send and verify the real M-Pesa payment first.
 * This route records that completed external payment; it does not send money.
 */
router.post("/:requestId/paid", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Admin access required."
    });
  }

  const receipt = String(req.body?.mpesaReceipt || "")
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9]{6,30}$/.test(receipt)) {
    return res.status(400).json({
      success: false,
      message:
        "Enter a valid M-Pesa receipt code after verifying the payment."
    });
  }

  const session = await mongoose.startSession();
  let result;

  try {
    await session.withTransaction(async () => {
      const withdrawal = await Withdrawal.findOneAndUpdate(
        {
          requestId: req.params.requestId,
          status: "approved",
          b2cInitiationState: "not_started",
          $or: [
            { b2cOriginatorConversationId: null },
            { b2cOriginatorConversationId: { $exists: false } }
          ]
        },
        {
          $set: {
            status: "paid",
            mpesaReceipt: receipt,
            reviewedBy: req.user._id,
            reviewedAt: new Date(),
            adminNote: null
          }
        },
        {
          returnDocument: 'after',
          runValidators: true,
          session
        }
      );

      if (!withdrawal) {
        const error = new Error("WITHDRAWAL_NOT_PENDING");
        error.code = "WITHDRAWAL_NOT_APPROVED";
        throw error;
      }

      if (!withdrawal.transactionId) {
        throw new Error("Withdrawal has no linked wallet transaction.");
      }

      await MpesaReceiptClaim.create(
        [{
          receipt,
          purpose: "withdrawal",
          referenceId: withdrawal.requestId,
          claimedBy: req.user._id,
          evidenceSource: "admin_manual_payout"
        }],
        { session }
      );

      const walletResult = await Wallet.updateOne(
        { userId: withdrawal.userId, currency: "USD" },
        {
          $inc: {
            totalWithdrawalsCents: withdrawal.amountCents
          }
        },
        { session, runValidators: true }
      );

      if (walletResult.matchedCount !== 1) {
        throw new Error("Wallet missing while recording withdrawal payout.");
      }

      const transactionResult = await WalletTransaction.updateOne(
        {
          _id: withdrawal.transactionId,
          userId: withdrawal.userId,
          type: "withdrawal",
          status: "pending"
        },
        {
          $set: {
            status: "completed",
            completedAt: new Date(),
            description:
              `Manually paid through M-Pesa. Receipt: ${receipt}`
          }
        },
        { session, runValidators: true }
      );

      if (transactionResult.modifiedCount !== 1) {
        throw new Error(
          "Linked withdrawal ledger entry was missing or already processed."
        );
      }

      await AdminAuditLog.create([{
        adminId: req.user._id,
        targetUserId: withdrawal.userId,
        action: "withdrawal.paid",
        reason: `Manual M-Pesa payout recorded with receipt ${receipt}.`,
        before: {
          status: "approved",
          amountCents: withdrawal.amountCents,
          currency: withdrawal.currency
        },
        after: {
          status: "paid",
          amountCents: withdrawal.amountCents,
          currency: withdrawal.currency,
          receipt,
          requestId: withdrawal.requestId
        },
        ipAddress: req.ip
      }], { session });

      result = {
        requestId: withdrawal.requestId,
        receipt
      };
    });

    return res.json({
      success: true,
      message: "Withdrawal marked as paid.",
      requestId: result.requestId,
      receipt: result.receipt
    });
  } catch (error) {
    if (error.code === "WITHDRAWAL_NOT_APPROVED") {
      const exists = await Withdrawal.exists({
        requestId: req.params.requestId
      });

      return res.status(exists ? 409 : 404).json({
        success: false,
        message: exists
          ? "This withdrawal must be approved before it can be marked as paid."
          : "Withdrawal request not found."
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "That M-Pesa receipt is already recorded."
      });
    }

    console.error("Mark withdrawal paid error:", error.message);

    return sendServerError(
      res,
      "Could not record the payout. Reconcile the actual M-Pesa transfer and database records before retrying."
    );
  } finally {
    await session.endSession();
  }
});

/*
 * POST /api/wallet/withdrawals/:requestId/reject
 * Body: { "reason": "Reason for rejection" }
 *
 * Rejection, refund, and ledger reversal commit together.
 */
router.post("/:requestId/reject", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Admin access required."
    });
  }

  const reason = String(req.body?.reason || "").trim();

  if (reason.length < 3 || reason.length > 300) {
    return res.status(400).json({
      success: false,
      message: "Provide a rejection reason between 3 and 300 characters."
    });
  }

  const session = await mongoose.startSession();
  let result;

  try {
    await session.withTransaction(async () => {
      const withdrawal = await Withdrawal.findOneAndUpdate(
        {
          requestId: req.params.requestId,
          status: "pending_review"
        },
        {
          $set: {
            status: "rejected",
            reviewedBy: req.user._id,
            reviewedAt: new Date(),
            adminNote: reason
          }
        },
        {
          returnDocument: 'after',
          runValidators: true,
          session
        }
      );

      if (!withdrawal) {
        const error = new Error("WITHDRAWAL_NOT_PENDING");
        error.code = "WITHDRAWAL_NOT_PENDING";
        throw error;
      }

      if (!withdrawal.transactionId) {
        throw new Error("Withdrawal has no linked wallet transaction.");
      }

      const refund = await Wallet.updateOne(
        { userId: withdrawal.userId, currency: "USD" },
        {
          $inc: {
            availableBalanceCents: withdrawal.amountCents
          }
        },
        { session, runValidators: true }
      );

      if (refund.matchedCount !== 1) {
        throw new Error("Wallet missing while refunding rejected withdrawal.");
      }

      const transactionResult = await WalletTransaction.updateOne(
        {
          _id: withdrawal.transactionId,
          userId: withdrawal.userId,
          type: "withdrawal",
          status: "pending"
        },
        {
          $set: {
            status: "reversed",
            description:
              `Withdrawal rejected and balance released: ${reason}`
          }
        },
        { session, runValidators: true }
      );

      if (transactionResult.modifiedCount !== 1) {
        throw new Error(
          "Linked withdrawal ledger entry was missing or already processed."
        );
      }


      await AdminAuditLog.create([{
        adminId: req.user._id,
        targetUserId: withdrawal.userId,
        action: "withdrawal.rejected",
        reason,
        before: {
          status: "pending_review",
          amountCents: withdrawal.amountCents,
          currency: withdrawal.currency
        },
        after: {
          status: "rejected",
          amountCents: withdrawal.amountCents,
          currency: withdrawal.currency,
          requestId: withdrawal.requestId
        },
        ipAddress: req.ip
      }], { session });

      result = { requestId: withdrawal.requestId };
    });

    return res.json({
      success: true,
      message: "Withdrawal rejected and reserved balance released.",
      requestId: result.requestId
    });
  } catch (error) {
    if (error.code === "WITHDRAWAL_NOT_PENDING") {
      const exists = await Withdrawal.exists({
        requestId: req.params.requestId
      });

      return res.status(exists ? 409 : 404).json({
        success: false,
        message: exists
          ? "This withdrawal has already been reviewed."
          : "Withdrawal request not found."
      });
    }

    console.error("Reject withdrawal error:", error.message);

    return sendServerError(
      res,
      "Could not complete the rejection. The transaction was not committed; verify the records before retrying."
    );
  } finally {
    await session.endSession();
  }
});

module.exports = router;
