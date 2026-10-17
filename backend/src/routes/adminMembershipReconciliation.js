const express = require("express");
const mongoose = require("mongoose");

const requireAuth = require("../middleware/requireAuth");
const MembershipPurchase = require("../models/MembershipPurchase");
const MembershipPaymentReconciliation = require(
  "../models/MembershipPaymentReconciliation"
);
const MpesaReceiptClaim = require("../models/MpesaReceiptClaim");
const Deposit = require("../models/Deposit");
const Withdrawal = require("../models/Withdrawal");

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

const PENDING_STATUSES = ["pending", "verification_required"];

function validObjectId(value) {
  return (
    typeof value === "string" &&
    mongoose.isValidObjectId(value)
  );
}

function normalizeReceipt(value) {
  return typeof value === "string"
    ? value.trim().toUpperCase()
    : "";
}

function errorResponse(res, status, message) {
  return res.status(status).json({
    success: false,
    message
  });
}

/**
 * GET /api/admin/membership-reconciliation
 *
 * Lists purchases that still need payment reconciliation.
 * This endpoint does not alter payment or membership state.
 */
router.get("/", async (req, res) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 50;

    const purchases = await MembershipPurchase.find({
      paymentStatus: { $in: PENDING_STATUSES }
    })
      .select(
        [
          "purchaseReference",
          "purchaserUserId",
          "planKey",
          "priceCents",
          "currency",
          "expectedAmountKes",
          "paymentStatus",
          "merchantRequestId",
          "checkoutRequestId",
          "createdAt",
          "lastReconciledAt"
        ].join(" ")
      )
      .populate("purchaserUserId", "username firstName lastName email")
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();

    return res.json({
      success: true,
      data: purchases
    });
  } catch (error) {
    console.error(
      "Membership reconciliation queue failed:",
      error.message
    );

    return errorResponse(
      res,
      500,
      "Could not load membership reconciliation queue."
    );
  }
});

/**
 * POST /api/admin/membership-reconciliation/:purchaseId/verify
 *
 * Requires an administrator to compare a purchase with authoritative
 * Safaricom evidence. This verifies payment only. It does not activate
 * a membership, credit a wallet, or distribute commissions.
 *
 * Expected JSON:
 * {
 *   "checkoutRequestId": "exact stored checkout ID",
 *   "amountKes": 100,
 *   "mpesaReceipt": "ABC123...",
 *   "evidenceSource": "safaricom_portal",
 *   "evidenceReference": "reference to the portal record or statement",
 *   "adminNote": "optional note"
 * }
 */
router.post("/:purchaseId/verify", async (req, res) => {
  const {
    checkoutRequestId,
    amountKes,
    evidenceSource,
    evidenceReference,
    adminNote = ""
  } = req.body || {};

  const mpesaReceipt = normalizeReceipt(req.body?.mpesaReceipt);

  if (!validObjectId(req.params.purchaseId)) {
    return errorResponse(res, 400, "Invalid purchase ID.");
  }

  if (
    typeof checkoutRequestId !== "string" ||
    !checkoutRequestId.trim() ||
    checkoutRequestId.length > 150
  ) {
    return errorResponse(
      res,
      400,
      "The exact stored checkout request ID is required."
    );
  }

  if (!Number.isSafeInteger(amountKes) || amountKes < 1) {
    return errorResponse(
      res,
      400,
      "The verified KSh amount must be a positive whole number."
    );
  }

  if (
    !mpesaReceipt ||
    mpesaReceipt.length > 30 ||
    !/^[A-Z0-9]+$/.test(mpesaReceipt)
  ) {
    return errorResponse(
      res,
      400,
      "A valid M-Pesa receipt is required."
    );
  }

  const allowedSources = [
    "safaricom_portal",
    "safaricom_statement"
    ];

  if (!allowedSources.includes(evidenceSource)) {
    return errorResponse(
      res,
      400,
      "Choose a supported Safaricom evidence source."
    );
  }

  if (
    typeof evidenceReference !== "string" ||
    !evidenceReference.trim() ||
    evidenceReference.trim().length > 150
  ) {
    return errorResponse(
      res,
      400,
      "An evidence reference is required."
    );
  }

  if (
    typeof adminNote !== "string" ||
    adminNote.length > 1000
  ) {
    return errorResponse(
      res,
      400,
      "The administrator note must be 1000 characters or fewer."
    );
  }

  let session;

  try {
    session = await mongoose.startSession();

    let verifiedPurchaseId = null;

    await session.withTransaction(async () => {
      const purchase = await MembershipPurchase.findById(
        req.params.purchaseId
      ).session(session);

      if (!purchase) {
        const error = new Error("PURCHASE_NOT_FOUND");
        error.code = "PURCHASE_NOT_FOUND";
        throw error;
      }

      if (!PENDING_STATUSES.includes(purchase.paymentStatus)) {
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

      // Do not accept a receipt already associated with another
      // membership purchase, a completed deposit, or a paid withdrawal.
      const [
        existingPurchase,
        existingDeposit,
        existingWithdrawal,
        existingReconciliation
      ] = await Promise.all([
        MembershipPurchase.findOne({
          _id: { $ne: purchase._id },
          mpesaReceipt
        }).session(session).lean(),

        Deposit.findOne({
          mpesaReceipt,
          status: "completed"
        }).session(session).lean(),

        Withdrawal.findOne({
          mpesaReceipt,
          status: "paid"
        }).session(session).lean(),

        MembershipPaymentReconciliation.findOne({
          mpesaReceipt
        }).session(session).lean()
      ]);

      if (
        existingPurchase ||
        existingDeposit ||
        existingWithdrawal ||
        existingReconciliation
      ) {
        const error = new Error("RECEIPT_ALREADY_USED");
        error.code = "RECEIPT_ALREADY_USED";
        throw error;
      }

      const verifiedAt = new Date();

      await MpesaReceiptClaim.create(
        [{
          receipt: mpesaReceipt,
          purpose: "membership_purchase",
          referenceId: String(purchase._id),
          amountKes,
          claimedBy: req.user._id,
          evidenceSource,
          evidenceReference: evidenceReference.trim()
        }],
        { session }
      );

      await MembershipPaymentReconciliation.create(
        [
          {
            purchaseId: purchase._id,
            purchaseReference: purchase.purchaseReference,
            checkoutRequestId: purchase.checkoutRequestId,
            mpesaReceipt,
            amountKes,
            evidenceSource,
            evidenceReference: evidenceReference.trim(),
            adminNote: adminNote.trim(),
            adminUserId: req.user._id,
            verifiedAt
          }
        ],
        { session }
      );

      const update = await MembershipPurchase.updateOne(
        {
          _id: purchase._id,
          paymentStatus: { $in: PENDING_STATUSES },
          checkoutRequestId: checkoutRequestId.trim(),
          expectedAmountKes: amountKes
        },
        {
          $set: {
            paymentStatus: "verified",
            mpesaReceipt,
            verifiedAmountKes: amountKes,
            verificationMethod: "admin_manual_reconciliation",
            verifiedAt,
            verificationReference: evidenceReference.trim(),
            lastReconciledAt: verifiedAt
          }
        },
        { session }
      );

      if (update.modifiedCount !== 1) {
        const error = new Error("PURCHASE_CHANGED");
        error.code = "PURCHASE_CHANGED";
        throw error;
      }

      verifiedPurchaseId = String(purchase._id);
    });

    return res.json({
      success: true,
      message:
        "Payment verified and audit recorded. Membership activation remains a separate operation.",
      data: {
        purchaseId: verifiedPurchaseId,
        paymentStatus: "verified",
        mpesaReceipt
      }
    });
  } catch (error) {
    if (error.code === "PURCHASE_NOT_FOUND") {
      return errorResponse(res, 404, "Membership purchase not found.");
    }

    if (error.code === "PURCHASE_NOT_PENDING") {
      return errorResponse(
        res,
        409,
        "This purchase is no longer awaiting reconciliation."
      );
    }

    if (error.code === "CHECKOUT_MISMATCH") {
      return errorResponse(
        res,
        409,
        "Checkout ID does not match the recorded purchase."
      );
    }

    if (error.code === "AMOUNT_MISMATCH") {
      return errorResponse(
        res,
        409,
        "Amount does not match the purchase's expected KSh amount."
      );
    }

    if (
      error.code === "RECEIPT_ALREADY_USED" ||
      error.code === 11000
    ) {
      return errorResponse(
        res,
        409,
        "This M-Pesa receipt is already recorded and cannot be reused."
      );
    }

    if (error.code === "PURCHASE_CHANGED") {
      return errorResponse(
        res,
        409,
        "Purchase state changed during verification. No verification was committed."
      );
    }

    console.error(
      "Membership payment verification failed:",
      error.message
    );

    // Transaction errors intentionally fail closed. Never fall back
    // to separate non-transactional writes for a financial operation.
    return errorResponse(
      res,
      503,
      "Verification could not be safely committed. Check MongoDB transaction support and retry after investigating."
    );
  } finally {
    if (session) {
      await session.endSession().catch(() => {});
    }
  }
});

module.exports = router;
