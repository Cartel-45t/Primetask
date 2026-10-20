const express = require("express");
const mongoose = require("mongoose");

const requireAuth = require("../middleware/requireAuth");
const Deposit = require("../models/Deposit");
const {
  completeVerifiedDeposit
} = require("../services/depositService");

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

function fail(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function normalizeReceipt(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/**
 * GET /api/admin/deposit-reconciliation
 * Lists pending Daraja deposits. This endpoint never credits a wallet.
 */
router.get("/", async (req, res) => {
  try {
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 100)
      : 50;

    const deposits = await Deposit.find({
      paymentMode: "daraja",
      status: "pending",
      checkoutRequestId: { $type: "string" }
    })
      .select([
        "_id",
        "requestId",
        "userId",
        "amountCents",
        "currency",
        "expectedAmountKes",
        "phoneNumber",
        "merchantRequestId",
        "checkoutRequestId",
        "createdAt",
        "status"
      ].join(" "))
      .populate("userId", "username firstName lastName email")
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();

    return res.json({ success: true, data: deposits });
  } catch (error) {
    console.error("Deposit reconciliation queue failed:", error.message);
    return fail(res, 500, "Could not load the deposit reconciliation queue.");
  }
});

/**
 * POST /api/admin/deposit-reconciliation/:depositId/verify
 *
 * An administrator must independently compare the payment against
 * authoritative Safaricom portal or statement evidence before submitting.
 */
router.post("/:depositId/verify", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.depositId)) {
    return fail(res, 400, "Invalid deposit ID.");
  }

  const {
    checkoutRequestId,
    amountKes,
    mpesaReceipt,
    evidenceSource,
    evidenceReference,
    reason
  } = req.body || {};

  const receipt = normalizeReceipt(mpesaReceipt);

  if (
    typeof checkoutRequestId !== "string" ||
    !checkoutRequestId.trim() ||
    checkoutRequestId.trim().length > 150
  ) {
    return fail(res, 400, "The recorded checkout ID is required.");
  }

  if (!Number.isSafeInteger(amountKes) || amountKes < 1) {
    return fail(res, 400, "Enter the exact whole-KSh payment amount.");
  }

  if (!/^[A-Z0-9]{6,30}$/.test(receipt)) {
    return fail(res, 400, "Enter a valid M-Pesa receipt.");
  }

  if (!["safaricom_portal", "safaricom_statement"].includes(evidenceSource)) {
    return fail(res, 400, "Choose Safaricom portal or statement evidence.");
  }

  if (
    typeof evidenceReference !== "string" ||
    !evidenceReference.trim() ||
    evidenceReference.trim().length > 150
  ) {
    return fail(res, 400, "An evidence reference is required.");
  }

  if (
    typeof reason !== "string" ||
    !reason.trim() ||
    reason.trim().length > 500
  ) {
    return fail(res, 400, "A verification reason is required.");
  }

  try {
    const deposit = await Deposit.findById(req.params.depositId).lean();

    if (!deposit) {
      return fail(res, 404, "Deposit not found.");
    }

    if (deposit.paymentMode !== "daraja" || deposit.status !== "pending") {
      return fail(res, 409, "This is not a pending Daraja deposit.");
    }

    if (
      !deposit.checkoutRequestId ||
      deposit.checkoutRequestId !== checkoutRequestId.trim()
    ) {
      return fail(res, 409, "Checkout ID does not match the recorded deposit.");
    }

    if (deposit.expectedAmountKes !== amountKes) {
      return fail(res, 409, "Amount does not match the expected KSh amount.");
    }

    const result = await completeVerifiedDeposit({
      requestId: deposit.requestId,
      resultCode: 0,
      amountKes,
      mpesaReceipt: receipt,
      checkoutRequestId: checkoutRequestId.trim(),
      evidenceSource,
      evidenceReference: evidenceReference.trim(),
      claimedBy: String(req.user._id),
      auditReason: reason.trim(),
      ipAddress: req.ip
    });

    return res.json({
      success: true,
      message: result.alreadyCredited
        ? "This deposit was already credited with the same receipt."
        : "Payment verified, USD wallet credited, and audit recorded.",
      data: result
    });
  } catch (error) {
    if (error.code === 11000) {
      return fail(res, 409, "This M-Pesa receipt has already been recorded.");
    }

    if (/not found/i.test(error.message)) {
      return fail(res, 404, "Deposit not found.");
    }

    if (
      /does not match|not awaiting|only Daraja|different receipt|status changed/i
        .test(error.message)
    ) {
      return fail(res, 409, error.message);
    }

    console.error("Deposit verification failed:", error.message);
    return fail(res, 500, "Deposit verification failed. No success is being reported.");
  }
});

module.exports = router;
