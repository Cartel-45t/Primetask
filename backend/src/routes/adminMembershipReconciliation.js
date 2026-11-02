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
const WalletTransaction = require("../models/WalletTransaction");
const Membership = require("../models/Membership");
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


/**
 * Reject and delete an unpaid pending Daraja membership purchase.
 * Requires an administrator's explicit Safaricom unpaid confirmation.
 * Callback events are deliberately preserved.
 */
router.post("/:purchaseId/reject-delete", async (req, res) => {
  const purchaseId = req.params.purchaseId;
  const reason = typeof req.body?.reason === "string"
    ? req.body.reason.trim()
    : "";

  if (!validObjectId(purchaseId)) {
    return errorResponse(res, 400, "Invalid membership purchase ID.");
  }

  if (reason.length < 3 || reason.length > 500) {
    return errorResponse(res, 400, "Reason must contain 3 to 500 characters.");
  }

  if (req.body?.safaricomStatusConfirmed !== "unpaid") {
    return errorResponse(
      res,
      400,
      "Explicit confirmation that Safaricom shows the payment as unpaid is required."
    );
  }

  let session;

  try {
    session = await mongoose.startSession();
    let deletedReference = null;

    await session.withTransaction(async () => {
      const purchase = await MembershipPurchase.findById(purchaseId)
        .session(session);

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

      if (purchase.paymentMethod !== "daraja") {
        const error = new Error("PAYMENT_METHOD_NOT_SUPPORTED");
        error.code = "PAYMENT_METHOD_NOT_SUPPORTED";
        throw error;
      }

      const hasPaymentEvidence = Boolean(
        purchase.mpesaReceipt ||
        purchase.verifiedAmountKes != null ||
        purchase.verificationMethod ||
        purchase.verifiedAt ||
        purchase.verificationReference ||
        purchase.membershipId ||
        purchase.activatedAt
      );

      if (hasPaymentEvidence) {
        const error = new Error("PAYMENT_EVIDENCE_PRESENT");
        error.code = "PAYMENT_EVIDENCE_PRESENT";
        throw error;
      }

      const referenceId = String(purchase._id);

      const [
        walletTransaction,
        membership,
        reconciliation,
        receiptClaim
      ] = await Promise.all([
        WalletTransaction.findOne({
          membershipPurchaseId: purchase._id
        }).session(session).lean(),

        Membership.findOne({
          purchaseId: purchase._id
        }).session(session).lean(),

        MembershipPaymentReconciliation.findOne({
          purchaseId: purchase._id
        }).session(session).lean(),

        MpesaReceiptClaim.findOne({
          purpose: "membership_purchase",
          referenceId
        }).session(session).lean()
      ]);

      if (walletTransaction || membership || reconciliation || receiptClaim) {
        const error = new Error("PURCHASE_HAS_LINKED_RECORDS");
        error.code = "PURCHASE_HAS_LINKED_RECORDS";
        throw error;
      }

      const before = {
        purchaseReference: purchase.purchaseReference,
        purchaserUserId: purchase.purchaserUserId,
        planKey: purchase.planKey,
        priceCents: purchase.priceCents,
        currency: purchase.currency,
        paymentMethod: purchase.paymentMethod,
        paymentStatus: purchase.paymentStatus,
        expectedAmountKes: purchase.expectedAmountKes,
        merchantRequestId: purchase.merchantRequestId || null,
        checkoutRequestId: purchase.checkoutRequestId || null,
        createdAt: purchase.createdAt,
        safaricomStatusConfirmed: "unpaid",
        safaricomCheckedAt: new Date()
      };

      const deletion = await MembershipPurchase.deleteOne({
        _id: purchase._id,
        paymentMethod: "daraja",
        paymentStatus: { $in: PENDING_STATUSES },
        mpesaReceipt: null,
        verifiedAmountKes: null,
        verificationMethod: null,
        verifiedAt: null,
        verificationReference: null,
        membershipId: null,
        activatedAt: null
      }).session(session);

      if (deletion.deletedCount !== 1) {
        const error = new Error("PURCHASE_CHANGED");
        error.code = "PURCHASE_CHANGED";
        throw error;
      }

      await AdminAuditLog.create([{
        adminId: req.user._id,
        targetUserId: purchase.purchaserUserId,
        action: "membership_purchase_rejected_deleted",
        reason,
        before,
        after: {
          status: "deleted",
          purchaseReference: purchase.purchaseReference
        },
        ipAddress: req.ip || null
      }], { session });

      deletedReference = purchase.purchaseReference;
    });

    return res.json({
      success: true,
      message: "Unpaid membership purchase rejected and deleted.",
      purchaseReference: deletedReference
    });

  } catch (error) {
    const knownErrors = {
      PURCHASE_NOT_FOUND: [404, "Membership purchase was not found."],
      PURCHASE_NOT_PENDING: [409, "Only pending or verification-required purchases can be deleted."],
      PAYMENT_METHOD_NOT_SUPPORTED: [409, "Only Daraja membership purchases can be deleted through this action."],
      PAYMENT_EVIDENCE_PRESENT: [409, "Payment or membership evidence exists. Deletion is blocked."],
      PURCHASE_HAS_LINKED_RECORDS: [409, "Linked financial, membership, reconciliation, or receipt records exist. Deletion is blocked."],
      PURCHASE_CHANGED: [409, "The purchase changed during deletion. No deletion was committed."]
    };

    if (knownErrors[error.code]) {
      return errorResponse(
        res,
        knownErrors[error.code][0],
        knownErrors[error.code][1]
      );
    }

    console.error("Membership purchase rejection/deletion failed:", error.message);

    return errorResponse(
      res,
      503,
      "Deletion could not be safely committed. Investigate MongoDB transaction support before retrying."
    );

  } finally {
    if (session) {
      await session.endSession().catch(() => {});
    }
  }
});

module.exports = router;
