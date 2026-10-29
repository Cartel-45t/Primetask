"use strict";

const express = require("express");
const mongoose = require("mongoose");
const requireAuth = require("../middleware/requireAuth");
const Package = require("../models/NotesPointsPackage");
const Purchase = require("../models/NotesPointsPurchase");
const PointsWallet = require("../models/NotesPointsWallet");
const PointsTransaction = require("../models/NotesPointsTransaction");
const { initiateStkPush } = require("../services/darajaService");

const router = express.Router();
router.use(requireAuth);

function publicPurchase(purchase) {
  return {
    packageName: purchase.packageName,
    points: purchase.points,
    expectedAmountKes: purchase.expectedAmountKes,
    paymentStatus: purchase.paymentStatus,
    createdAt: purchase.createdAt,
    verifiedAt: purchase.verifiedAt || null
  };
}

router.get("/packages", async (_req, res) => {
  try {
    const packages = await Package.find({ isActive: true })
      .sort({ points: 1 })
      .select("name points priceKes")
      .lean();

    return res.json({
      success: true,
      packages: packages.map(item => ({
        id: String(item._id),
        name: item.name,
        points: item.points,
        priceKes: item.priceKes
      }))
    });
  } catch (error) {
    console.error("Notes Points packages error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load Notes Points packages."
    });
  }
});

router.get("/status", async (req, res) => {
  try {
    const purchase = await Purchase.findOne({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .select("packageName points expectedAmountKes paymentStatus createdAt verifiedAt")
      .lean();

    if (!purchase) {
      return res.json({ success: true, purchase: null });
    }

    return res.json({
      success: true,
      purchase: {
        packageName: purchase.packageName,
        points: purchase.points,
        expectedAmountKes: purchase.expectedAmountKes,
        paymentStatus: purchase.paymentStatus,
        createdAt: purchase.createdAt,
        verifiedAt: purchase.verifiedAt || null
      }
    });
  } catch (error) {
    console.error("Notes Points payment status error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to check the payment status."
    });
  }
});

router.post("/", async (req, res) => {
  const packageId = req.body?.packageId;
  const phoneNumber = typeof req.body?.phoneNumber === "string"
    ? req.body.phoneNumber.trim()
    : "";
  const idempotencyKey = String(req.get("Idempotency-Key") || "").trim();

  if (!mongoose.isValidObjectId(packageId)) {
    return res.status(400).json({
      success: false,
      message: "A valid Points package is required."
    });
  }

  if (!/^254[17]\d{8}$/.test(phoneNumber)) {
    return res.status(400).json({
      success: false,
      message: "Use a valid Kenyan M-Pesa number in 254XXXXXXXXX format."
    });
  }

  if (idempotencyKey.length < 8 || idempotencyKey.length > 150) {
    return res.status(400).json({
      success: false,
      message: "A unique Idempotency-Key header of 8 to 150 characters is required."
    });
  }

  try {
    const existing = await Purchase.findOne({
      userId: req.user._id,
      idempotencyKey
    });

    if (existing) {
      if (
        String(existing.packageId) !== String(packageId) ||
        existing.phoneNumber !== phoneNumber
      ) {
        return res.status(409).json({
          success: false,
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "This idempotency key was already used for different purchase details."
        });
      }

      return res.status(200).json({
        success: true,
        duplicate: true,
        purchase: publicPurchase(existing),
        message: "This purchase request was already recorded."
      });
    }

    const packageDoc = await Package.findOne({
      _id: packageId,
      isActive: true
    }).lean();

    if (!packageDoc) {
      return res.status(404).json({
        success: false,
        message: "This Points package is unavailable."
      });
    }

    const unresolved = await Purchase.findOne({
      userId: req.user._id,
      hasUnresolvedPayment: true
    }).lean();

    if (unresolved) {
      return res.status(409).json({
        success: false,
        code: "PAYMENT_ALREADY_UNRESOLVED",
        message: "A previous M-Pesa payment is still awaiting confirmation. Do not start another payment."
      });
    }

    const purchase = await Purchase.create({
      userId: req.user._id,
      idempotencyKey,
      packageId: packageDoc._id,
      packageName: packageDoc.name,
      points: packageDoc.points,
      expectedAmountKes: packageDoc.priceKes,
      phoneNumber,
      paymentStatus: "pending",
      hasUnresolvedPayment: true
    });

    try {
      const stk = await initiateStkPush({
        phoneNumber,
        amountKes: purchase.expectedAmountKes,
        accountReference: purchase.purchaseReference,
        transactionDesc: `Notes Points ${purchase.points}`
      });

      const checkoutRequestId = stk?.checkoutRequestId || stk?.CheckoutRequestID;
      const merchantRequestId = stk?.merchantRequestId || stk?.MerchantRequestID;

      if (
        typeof checkoutRequestId !== "string" ||
        !checkoutRequestId ||
        typeof merchantRequestId !== "string" ||
        !merchantRequestId
      ) {
        await Purchase.updateOne(
          { _id: purchase._id },
          {
            $set: {
              paymentStatus: "verification_required",
              failureCode: "STK_RESPONSE_INCOMPLETE",
              failureDescription: "The STK request response did not include the required request identifiers."
            }
          }
        );

        return res.status(202).json({
          success: true,
          paymentPending: true,
          purchase: publicPurchase(await Purchase.findById(purchase._id)),
          message: "The payment request needs verification. Do not initiate another payment."
        });
      }

      purchase.checkoutRequestId = checkoutRequestId;
      purchase.merchantRequestId = merchantRequestId;
      await purchase.save();

      return res.status(202).json({
        success: true,
        paymentPending: true,
        purchase: publicPurchase(purchase),
        message: "M-Pesa prompt requested. Points are credited only after payment verification."
      });
    } catch (error) {
      await Purchase.updateOne(
        { _id: purchase._id, paymentStatus: "pending" },
        {
          $set: {
            paymentStatus: "verification_required",
            failureCode: "STK_INITIATION_UNCERTAIN",
            failureDescription: "STK initiation did not return a safely confirmed outcome. Verify before retrying."
          }
        }
      );

      console.error("Notes Points STK initiation unresolved:", error.message);
      return res.status(202).json({
        success: true,
        paymentPending: true,
        purchase: publicPurchase(await Purchase.findById(purchase._id)),
        message: "The payment outcome is not yet confirmed. Do not retry until it has been checked."
      });
    }
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        code: "PURCHASE_CONFLICT",
        message: "A purchase is already recorded or awaiting confirmation."
      });
    }

    console.error("Notes Points purchase creation error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to start the Notes Points purchase."
    });
  }
});

module.exports = router;
