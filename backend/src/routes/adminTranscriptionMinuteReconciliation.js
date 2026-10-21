"use strict";

const express = require("express");
const mongoose = require("mongoose");
const requireAuth = require("../middleware/requireAuth");
const MinutePurchase = require("../models/TranscriptionMinutePurchase");
const MinuteWallet = require("../models/TranscriptionMinuteWallet");
const MinuteTransaction = require("../models/TranscriptionMinuteTransaction");
const MpesaReceiptClaim = require("../models/MpesaReceiptClaim");
const AdminAuditLog = require("../models/AdminAuditLog");

const router = express.Router();
router.use(requireAuth);

router.use((req, res, next) => {
  if (!["admin", "founder"].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: "Administrator access is required."
    });
  }
  next();
});

const PENDING = ["pending", "verification_required"];

function fail(res, status, message) {
  return res.status(status).json({ success: false, message });
}

router.get("/", async (req, res) => {
  try {
    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), 100)
      : 50;

    const purchases = await MinutePurchase.find({
      paymentStatus: { $in: PENDING }
    })
      .select(
        "purchaseReference userId packageName minutes priceCents currency expectedAmountKes phoneNumber paymentStatus merchantRequestId checkoutRequestId createdAt lastReconciledAt"
      )
      .populate("userId", "username firstName lastName email")
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();

    return res.json({ success: true, purchases });
  } catch (error) {
    console.error("Minute reconciliation queue failed:", error.message);
    return fail(res, 500, "Could not load minute purchase reconciliation.");
  }
});

router.post("/:purchaseId/verify", async (req, res) => {
  const {
    checkoutRequestId,
    amountKes,
    evidenceSource,
    evidenceReference
  } = req.body || {};

  const mpesaReceipt =
    typeof req.body?.mpesaReceipt === "string"
      ? req.body.mpesaReceipt.trim().toUpperCase()
      : "";

  if (!mongoose.isValidObjectId(req.params.purchaseId)) {
    return fail(res, 400, "Invalid purchase ID.");
  }

  if (
    typeof checkoutRequestId !== "string" ||
    !checkoutRequestId.trim() ||
    checkoutRequestId.trim().length > 150
  ) {
    return fail(res, 400, "The exact stored checkout request ID is required.");
  }

  if (!Number.isSafeInteger(amountKes) || amountKes < 1) {
    return fail(res, 400, "The verified KSh amount must be a positive whole number.");
  }

  if (!/^[A-Z0-9]{6,30}$/.test(mpesaReceipt)) {
    return fail(res, 400, "Provide a valid M-Pesa receipt.");
  }

  if (!["safaricom_portal", "safaricom_statement"].includes(evidenceSource)) {
    return fail(res, 400, "Use supported Safaricom portal or statement evidence.");
  }

  if (
    typeof evidenceReference !== "string" ||
    !evidenceReference.trim() ||
    evidenceReference.trim().length > 150
  ) {
    return fail(res, 400, "An evidence reference is required.");
  }

  let session;

  try {
    session = await mongoose.startSession();
    let result;

    await session.withTransaction(async () => {
      const purchase = await MinutePurchase.findById(
        req.params.purchaseId
      ).session(session);

      if (!purchase) {
        const error = new Error("PURCHASE_NOT_FOUND");
        error.code = "PURCHASE_NOT_FOUND";
        throw error;
      }

      if (!PENDING.includes(purchase.paymentStatus)) {
        const error = new Error("PURCHASE_NOT_PENDING");
        error.code = "PURCHASE_NOT_PENDING";
        throw error;
      }

      if (
        !purchase.checkoutRequestId ||
        purchase.checkoutRequestId !== checkoutRequestId.trim()
      ) {
        const error = new Error("CHECKOUT_MISMATCH");
        error.code = "CHECKOUT_MISMATCH";
        throw error;
      }

      if (
        !Number.isSafeInteger(purchase.expectedAmountKes) ||
        purchase.expectedAmountKes !== amountKes
      ) {
        const error = new Error("AMOUNT_MISMATCH");
        error.code = "AMOUNT_MISMATCH";
        throw error;
      }

      const verifiedAt = new Date();

      // The globally unique receipt claim protects all payment services.
      await MpesaReceiptClaim.create([{
        receipt: mpesaReceipt,
        purpose: "transcription_minute_purchase",
        referenceId: String(purchase._id),
        amountKes,
        claimedBy: req.user._id,
        evidenceSource,
        evidenceReference: evidenceReference.trim(),
        claimedAt: verifiedAt
      }], { session });

      const wallet = await MinuteWallet.findOneAndUpdate(
        { userId: purchase.userId },
        {
          $setOnInsert: { userId: purchase.userId },
          $inc: {
            availableMinutes: purchase.minutes,
            totalPurchasedMinutes: purchase.minutes
          }
        },
        {
          new: true,
          upsert: true,
          session,
          runValidators: true,
          setDefaultsOnInsert: true
        }
      );

      await MinuteTransaction.create([{
        userId: purchase.userId,
        walletId: wallet._id,
        type: "purchase_credit",
        minutes: purchase.minutes,
        reference: `TRANSCRIPTION-MINUTE-PURCHASE-${purchase._id}`,
        purchaseId: purchase._id,
        description: `Verified purchase: ${purchase.packageName}`,
        createdByAdminId: req.user._id
      }], { session });

      const update = await MinutePurchase.updateOne(
        {
          _id: purchase._id,
          paymentStatus: { $in: PENDING },
          checkoutRequestId: checkoutRequestId.trim(),
          expectedAmountKes: amountKes
        },
        {
          $set: {
            paymentStatus: "verified",
            hasUnresolvedPayment: false,
            mpesaReceipt,
            verifiedAmountKes: amountKes,
            verificationMethod: "admin_manual_reconciliation",
            evidenceSource,
            evidenceReference: evidenceReference.trim(),
            verifiedByAdminId: req.user._id,
            verifiedAt,
            lastReconciledAt: verifiedAt
          }
        },
        { session, runValidators: true }
      );

      if (update.modifiedCount !== 1) {
        const error = new Error("PURCHASE_CHANGED");
        error.code = "PURCHASE_CHANGED";
        throw error;
      }

      await AdminAuditLog.create([{
        adminId: req.user._id,
        targetUserId: purchase.userId,
        action: "transcription_minute_purchase_verified",
        reason: `Manually reconciled M-Pesa payment using ${evidenceSource}; evidence reference: ${evidenceReference.trim()}`,
        before: {
          paymentStatus: purchase.paymentStatus,
          availableMinutesCredited: 0
        },
        after: {
          paymentStatus: "verified",
          minutesCredited: purchase.minutes,
          amountKes,
          mpesaReceipt
        },
        ipAddress: req.ip || null
      }], { session });

      result = {
        purchaseId: String(purchase._id),
        paymentStatus: "verified",
        minutesCredited: purchase.minutes,
        mpesaReceipt
      };
    });

    return res.json({
      success: true,
      message: "Payment verified and minute wallet credited atomically.",
      data: result
    });
  } catch (error) {
    if (error.code === "PURCHASE_NOT_FOUND") {
      return fail(res, 404, "Minute purchase not found.");
    }

    if (error.code === "PURCHASE_NOT_PENDING") {
      return fail(res, 409, "This purchase is no longer awaiting verification.");
    }

    if (error.code === "CHECKOUT_MISMATCH") {
      return fail(res, 409, "Checkout ID does not match the stored purchase.");
    }

    if (error.code === "AMOUNT_MISMATCH") {
      return fail(res, 409, "Amount does not match the expected KSh amount.");
    }

    if (error.code === "PURCHASE_CHANGED") {
      return fail(res, 409, "Purchase state changed; no verification was committed.");
    }

    if (error.code === 11000) {
      return fail(res, 409, "This receipt or purchase-credit reference is already claimed.");
    }

    console.error("Minute purchase verification failed:", error.message);
    return fail(
      res,
      503,
      "Verification was not safely committed. Check MongoDB transaction support before retrying."
    );
  } finally {
    if (session) await session.endSession().catch(() => {});
  }
});

module.exports = router;
