"use strict";

const express = require("express");
const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");
const requireAuth = require("../middleware/requireAuth");
const MinutePackage = require("../models/TranscriptionMinutePackage");
const MinutePurchase = require("../models/TranscriptionMinutePurchase");
const darajaService = require("../services/transcriptionDarajaService");

const router = express.Router();
router.use(requireAuth);

function normalizePhone(value) {
  if (typeof value !== "string") return null;

  const digits = value.replace(/[\s()+-]/g, "");

  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;

  return null;
}

function publicPurchase(doc) {
  return {
    id: String(doc._id),
    purchaseReference: doc.purchaseReference,
    packageId: String(doc.packageId),
    packageName: doc.packageName,
    minutes: doc.minutes,
    price: doc.priceCents / 100,
    currency: "USD",
    expectedAmountKes: doc.expectedAmountKes,
    phoneNumber: doc.phoneNumber,
    paymentStatus: doc.paymentStatus,
    checkoutRequestId: doc.checkoutRequestId || null,
    mpesaReceipt: doc.mpesaReceipt || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

router.get("/packages", async (req, res) => {
  try {
    const packages = await MinutePackage.find({ isActive: true })
      .sort({ minutes: 1, createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      packages: packages.map(pkg => ({
        id: String(pkg._id),
        name: pkg.name,
        minutes: pkg.minutes,
        price: pkg.priceCents / 100,
        currency: "USD",
        priceKes: pkg.priceKes
      }))
    });
  } catch (error) {
    console.error("Public minute packages failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load minute packages."
    });
  }
});

router.get("/", async (req, res) => {
  try {
    const purchases = await MinutePurchase.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return res.json({
      success: true,
      purchases: purchases.map(publicPurchase)
    });
  } catch (error) {
    console.error("Minute purchase history failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load purchase history."
    });
  }
});

router.post("/", async (req, res) => {
  const body = req.body || {};
  const packageId = body.packageId;
  const idempotencyKey = body.idempotencyKey;
  const phoneNumber = normalizePhone(body.phoneNumber);

  if (!mongoose.isValidObjectId(packageId)) {
    return res.status(400).json({
      success: false,
      message: "Select a valid minute package."
    });
  }

  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length < 8 ||
    idempotencyKey.trim().length > 150
  ) {
    return res.status(400).json({
      success: false,
      message: "A unique idempotency key of 8 to 150 characters is required."
    });
  }

  if (!phoneNumber) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid Kenyan M-Pesa number."
    });
  }

  try {
    const existing = await MinutePurchase.findOne({
      userId: req.user._id,
      idempotencyKey: idempotencyKey.trim()
    });

    if (existing) {
      return res.status(200).json({
        success: true,
        reused: true,
        message: "Existing purchase returned. No duplicate purchase was created.",
        purchase: publicPurchase(existing)
      });
    }

    const pkg = await MinutePackage.findOne({
      _id: packageId,
      isActive: true
    }).lean();

    if (!pkg) {
      return res.status(404).json({
        success: false,
        message: "Active minute package not found."
      });
    }

    const purchase = await MinutePurchase.create({
      purchaseReference: `PTW-TM-${randomUUID()}`,
      userId: req.user._id,
      idempotencyKey: idempotencyKey.trim(),
      packageId: pkg._id,
      packageName: pkg.name,
      minutes: pkg.minutes,
      priceCents: pkg.priceCents,
      currency: "USD",
      expectedAmountKes: pkg.priceKes,
      phoneNumber,
      paymentStatus: "pending"
    });

    return res.status(201).json({
      success: true,
      message: "Purchase recorded. Payment initiation is not enabled yet; no payment has been requested or confirmed.",
      paymentInitiationEnabled: false,
      purchase: publicPurchase(purchase)
    });
  } catch (error) {
    if (error.code === 11000) {
      try {
        const existing = await MinutePurchase.findOne({
          userId: req.user._id,
          idempotencyKey: idempotencyKey.trim()
        });

        if (existing) {
          return res.status(200).json({
            success: true,
            reused: true,
            purchase: publicPurchase(existing)
          });
        }
      } catch (_) {
        // Return the safe failure response below.
      }
    }

    console.error("Minute purchase creation failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not safely create the minute purchase."
    });
  }
});


// Initiate one STK prompt for an existing purchase. Never credit minutes here.
router.post("/:purchaseId/initiate", async (req, res) => {
  const { purchaseId } = req.params;

  if (!mongoose.isValidObjectId(purchaseId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid purchase reference."
    });
  }

  try {
    const purchase = await MinutePurchase.findOne({
      _id: purchaseId,
      userId: req.user._id
    });

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: "Minute purchase not found."
      });
    }

    if (purchase.paymentStatus !== "pending") {
      return res.status(409).json({
        success: false,
        message: "This purchase is not eligible for a new payment prompt. Check its status or contact support.",
        purchase: publicPurchase(purchase)
      });
    }

    if (purchase.checkoutRequestId || purchase.merchantRequestId) {
      return res.status(409).json({
        success: false,
        message: "A payment request has already been recorded for this purchase. Do not send another prompt.",
        purchase: publicPurchase(purchase)
      });
    }

    // Atomically reserve initiation so simultaneous requests cannot send two prompts.
    const claimed = await MinutePurchase.findOneAndUpdate(
      {
        _id: purchase._id,
        userId: req.user._id,
        paymentStatus: "pending",
        checkoutRequestId: null,
        merchantRequestId: null
      },
      {
        $set: {
          paymentStatus: "verification_required",
          failureCode: "STK_INITIATION_IN_PROGRESS",
          failureDescription: "STK initiation is being processed. Verify the result before retrying."
        }
      },
      { new: true }
    );

    if (!claimed) {
      return res.status(409).json({
        success: false,
        message: "Payment initiation is already in progress or this purchase has changed. Refresh the purchase history."
      });
    }

    let result;

    try {
      result = await darajaService.initiateStkPush({
        phoneNumber: claimed.phoneNumber,
        amountKes: claimed.expectedAmountKes,
        accountReference: claimed.purchaseReference,
        transactionDesc: `Minutes ${claimed.minutes}`
      });
    } catch (error) {
      // Provider outcome may be uncertain. Keep the purchase locked for reconciliation.
      console.error("Minute STK initiation requires reconciliation:", error.message);
      return res.status(503).json({
        success: false,
        paymentStatus: "verification_required",
        message: "We could not confirm the payment prompt result. Do not retry this purchase yet; it requires payment reconciliation."
      });
    }

    if (result.mode === "disabled") {
      await MinutePurchase.updateOne(
        {
          _id: claimed._id,
          paymentStatus: "verification_required",
          failureCode: "STK_INITIATION_IN_PROGRESS"
        },
        {
          $set: { paymentStatus: "pending" },
          $unset: { failureCode: 1, failureDescription: 1 }
      });
      return res.status(503).json({
        success: false,
        paymentInitiationEnabled: false,
        message: "M-Pesa payment initiation is disabled. No payment prompt was requested."
      });
    }

    const hasIdentifiers =
      typeof result.checkoutRequestId === "string" &&
      result.checkoutRequestId.length > 0 &&
      typeof result.merchantRequestId === "string" &&
      result.merchantRequestId.length > 0;

    if (!result.accepted || !hasIdentifiers) {
      await MinutePurchase.updateOne(
        { _id: claimed._id, paymentStatus: "verification_required" },
        {
          $set: {
            ...(result.checkoutRequestId ? { checkoutRequestId: result.checkoutRequestId } : {}),
            ...(result.merchantRequestId ? { merchantRequestId: result.merchantRequestId } : {}),
            failureCode: "STK_RESULT_REQUIRES_RECONCILIATION",
            failureDescription: String(result.responseDescription || "Safaricom did not provide a confirmed STK acceptance result.").slice(0, 500)
          }
        }
      );

      return res.status(502).json({
        success: false,
        paymentStatus: "verification_required",
        message: "Safaricom did not confirm the prompt. The purchase is locked for reconciliation; do not initiate it again."
      });
    }

    const updated = await MinutePurchase.findOneAndUpdate(
      {
        _id: claimed._id,
        paymentStatus: "verification_required",
        failureCode: "STK_INITIATION_IN_PROGRESS"
      },
      {
        $set: {
          merchantRequestId: result.merchantRequestId,
          checkoutRequestId: result.checkoutRequestId,
          paymentStatus: "pending"
        },
        $unset: { failureCode: 1, failureDescription: 1 }
      },
      { new: true }
    );

    if (!updated) {
      return res.status(503).json({
        success: false,
        paymentStatus: "verification_required",
        message: "Safaricom accepted the request, but the purchase record needs reconciliation. Do not retry."
      });
    }

    return res.status(200).json({
      success: true,
      paymentInitiationEnabled: true,
      message: result.customerMessage || "Payment prompt accepted by Safaricom. Complete the prompt on your phone. Minutes are credited only after payment verification.",
      purchase: publicPurchase(updated)
    });
  } catch (error) {
    console.error("Minute STK endpoint failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not safely process the payment initiation request."
    });
  }
});

module.exports = router;
