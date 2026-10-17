"use strict";

const express = require("express");
const mongoose = require("mongoose");
const requireAuth = require("../middleware/requireAuth");
const MembershipPurchase = require("../models/MembershipPurchase");
const { fulfilMembershipPurchase } = require(
  "../services/membershipFulfilmentService"
);

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

router.get("/", async (req, res) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 50;

    const purchases = await MembershipPurchase.find({
      paymentStatus: "verified",
      membershipId: null,
      activatedAt: null
    })
      .select(
        "purchaseReference purchaserUserId planKey priceCents currency expectedAmountKes paymentStatus commissionEnabledSnapshot createdAt"
      )
      .populate("purchaserUserId", "firstName lastName username email")
      .sort({ verifiedAt: 1, createdAt: 1 })
      .limit(limit)
      .lean();

    return res.json({ success: true, purchases });
  } catch (error) {
    console.error("Membership fulfilment queue error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load the membership fulfilment queue."
    });
  }
});

router.post("/:purchaseId/fulfil", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.purchaseId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid membership purchase ID."
    });
  }

  try {
    const data = await fulfilMembershipPurchase(
      req.params.purchaseId
    );

    return res.json({
      success: true,
      message: "Membership activated and eligible commissions credited.",
      data
    });
  } catch (error) {
    const responses = {
      PURCHASE_NOT_FOUND: [404, "Membership purchase not found."],
      PURCHASER_NOT_FOUND: [409, "The purchaser account no longer exists."],
      PAYMENT_NOT_VERIFIED: [409, "Verify payment before fulfilling this purchase."],
      ALREADY_FULFILLED: [409, "This purchase has already been fulfilled."],
      PURCHASE_CHANGED: [409, "The purchase changed during fulfilment. Refresh the queue."],
      INVALID_PURCHASE_SNAPSHOT: [409, "The saved purchase terms are invalid."]
    };

    if (responses[error.code]) {
      const [status, message] = responses[error.code];
      return res.status(status).json({ success: false, message });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "A duplicate fulfilment record was detected. Refresh the queue before retrying."
      });
    }

    console.error("Membership fulfilment failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Fulfilment failed. No partial transaction was committed."
    });
  }
});

module.exports = router;
