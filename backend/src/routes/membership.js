"use strict";

const express = require("express");
const mongoose = require("mongoose");
const MembershipPurchase = require("../models/MembershipPurchase");
const { initiateStkPush } = require("../services/darajaService");
const { fulfilMembershipPurchase } = require("../services/membershipFulfilmentService");

const MembershipPlan = require("../models/MembershipPlan");
const Membership = require("../models/Membership");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

router.use(requireAuth);

function serializePlan(plan) {
  return {
    id: String(plan._id),
    key: plan.key,
    name: plan.name,
    description: plan.description,
    price: Number((plan.priceCents / 100).toFixed(2)),
    currency: "USD",
    durationDays: plan.durationDays,
    services: plan.services,
    commissionEnabled: plan.commissionEnabled,
    mpesaAmountKes: plan.mpesaAmountKes
  };
}

/*
 * GET /api/membership/plans
 * Lists active plans only. It does not create or activate a membership.
 */
router.get("/plans", async (req, res) => {
  try {
    const plans = await MembershipPlan.find({
      active: true
    })
      .select(
        "key name description priceCents mpesaAmountKes durationDays services commissionEnabled"
      )
      .sort({ priceCents: 1, name: 1 })
      .lean();

    return res.json({
      success: true,
      currency: "USD",
      plans: plans.map(serializePlan)
    });
  } catch (error) {
    console.error("Membership plan list error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load membership plans."
    });
  }
});

/*
 * GET /api/membership
 * Returns the signed-in user's current valid membership and history.
 */
router.get("/", async (req, res) => {
  try {
    const now = new Date();

    const current = await Membership.findOne({
      userId: req.user._id,
      status: "active",
      startsAt: { $lte: now },
      expiresAt: { $gt: now }
    })
      .sort({ expiresAt: -1, _id: -1 })
      .select(
        "planId planKey priceCents currency services status startsAt expiresAt activatedAt grantSource grantReason"
      )
      .lean();

    const history = await Membership.find({ userId: req.user._id })
      .sort({ createdAt: -1, _id: -1 })
      .limit(20)
      .select(
        "planKey priceCents currency services status startsAt expiresAt activatedAt createdAt grantSource grantReason"
      )
      .lean();

    return res.json({
      success: true,
      membership: current
        ? {
            id: String(current._id),
            planId: String(current.planId),
            planKey: current.planKey,
            price: Number((current.priceCents / 100).toFixed(2)),
            currency: "USD",
            services: current.services,
            status: "active",
            startsAt: current.startsAt,
            expiresAt: current.expiresAt,
            activatedAt: current.activatedAt,
            grantSource: current.grantSource || "purchase",
            grantReason: current.grantReason || ""
          }
        : null,
      allowedServices: current ? current.services : [],
      history: history.map(item => ({
        planKey: item.planKey,
        price: Number((item.priceCents / 100).toFixed(2)),
        currency: "USD",
        services: item.services,
        status: item.status,
        startsAt: item.startsAt,
        expiresAt: item.expiresAt,
        activatedAt: item.activatedAt,
        createdAt: item.createdAt,
        grantSource: item.grantSource || "purchase",
        grantReason: item.grantReason || ""
      }))
    });
  } catch (error) {
    console.error("Membership status error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load membership status."
    });
  }
});


/*
 * POST /api/membership/purchases
 *
 * Creates a purchase snapshot and requests an STK push.
 * This route NEVER activates memberships, pays commissions,
 * or credits wallets. Those actions require independent
 * payment reconciliation and an atomic activation service.
 *
 * Headers:
 *   Idempotency-Key: unique client-generated request key
 *
 * Body:
 *   { "planId": "...", "phoneNumber": "0712345678" }
 */
router.post("/purchases", async (req, res) => {
  try {
    const idempotencyKey = req.get("Idempotency-Key");

    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 150 ||
      !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_IDEMPOTENCY_KEY",
        message: "A valid Idempotency-Key header is required."
      });
    }

    /*
     * A disabled provider must not create unusable purchase records.
     * Keep DARAJA_LIVE_ENABLED unset/false until reconciliation
     * and activation are implemented and tested.
     */
    if (process.env.DARAJA_LIVE_ENABLED !== "true") {
      return res.status(503).json({
        success: false,
        code: "DARAJA_DISABLED",
        message: "Membership payments are temporarily unavailable."
      });
    }

    const { planId } = req.body || {};
    const rawPhone = req.body?.phoneNumber;

    if (
      typeof planId !== "string" ||
      !mongoose.isValidObjectId(planId)
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_PLAN",
        message: "Select a valid membership plan."
      });
    }

    if (typeof rawPhone !== "string") {
      return res.status(400).json({
        success: false,
        code: "INVALID_PHONE",
        message: "Enter a valid Kenyan mobile number."
      });
    }

    const digits = rawPhone.trim().replace(/[\s()-]/g, "");
    let phoneNumber = digits;

    if (/^0[17]\d{8}$/.test(digits)) {
      phoneNumber = "254" + digits.slice(1);
    } else if (/^\+254[17]\d{8}$/.test(digits)) {
      phoneNumber = digits.slice(1);
    }

    if (!/^254[17]\d{8}$/.test(phoneNumber)) {
      return res.status(400).json({
        success: false,
        code: "INVALID_PHONE",
        message: "Enter a valid Kenyan mobile number."
      });
    }

    /*
     * Check idempotency before reading mutable plan data.
     * Reusing a key with different details is a conflict.
     */
    const existing = await MembershipPurchase.findOne({
      purchaserUserId: req.user._id,
      idempotencyKey
    }).lean();

    if (existing) {
      if (
        String(existing.planId) !== planId ||
        existing.phoneNumber !== phoneNumber
      ) {
        return res.status(409).json({
          success: false,
          code: "IDEMPOTENCY_CONFLICT",
          message:
            "This key was already used for different purchase details."
        });
      }

      return res.status(200).json({
        success: true,
        reused: true,
        message:
          "This purchase already exists. No additional STK prompt was sent.",
        purchase: serializePurchase(existing)
      });
    }

    const plan = await MembershipPlan.findOne({
      _id: planId,
      active: true,
      mpesaAmountKes: { $type: "number", $gt: 0 }
    })
      .select(
        "key name priceCents durationDays services commissionEnabled commissionAmountsCents mpesaAmountKes"
      )
      .lean();

    if (!plan) {
      return res.status(404).json({
        success: false,
        code: "PLAN_UNAVAILABLE",
        message: "This membership plan is unavailable for purchase."
      });
    }

    if (
      !Number.isSafeInteger(plan.priceCents) ||
      plan.priceCents < 1 ||
      !Number.isSafeInteger(plan.mpesaAmountKes) ||
      plan.mpesaAmountKes < 1 ||
      !Number.isSafeInteger(plan.durationDays) ||
      plan.durationDays < 1 ||
      !Array.isArray(plan.services) ||
      !Array.isArray(plan.commissionAmountsCents) ||
      plan.commissionAmountsCents.length !== 4 ||
      !plan.commissionAmountsCents.every(
        amount => Number.isSafeInteger(amount) && amount >= 0
      )
    ) {
      return res.status(409).json({
        success: false,
        code: "INVALID_PLAN_CONFIGURATION",
        message: "The plan configuration needs administrator review."
      });
    }

    let purchase;

    try {
      purchase = await MembershipPurchase.create({
        idempotencyKey,
        purchaserUserId: req.user._id,
        planId: plan._id,
        planKey: plan.key,
        priceCents: plan.priceCents,
        currency: "USD",
        expectedAmountKes: plan.mpesaAmountKes,
        durationDays: plan.durationDays,
        services: plan.services,
        commissionEnabledSnapshot: plan.commissionEnabled === true,
        commissionAmountsCentsSnapshot:
          plan.commissionAmountsCents.slice(),
        phoneNumber,
        paymentStatus: "pending"
      });
    } catch (error) {
      if (error.code === 11000) {
        const concurrent = await MembershipPurchase.findOne({
          purchaserUserId: req.user._id,
          idempotencyKey
        }).lean();

        if (concurrent) {
          if (
            String(concurrent.planId) !== planId ||
            concurrent.phoneNumber !== phoneNumber
          ) {
            return res.status(409).json({
              success: false,
              code: "IDEMPOTENCY_CONFLICT",
              message:
                "This key was already used for different purchase details."
            });
          }

          return res.status(200).json({
            success: true,
            reused: true,
            message:
              "This purchase already exists. No additional STK prompt was sent.",
            purchase: serializePurchase(concurrent)
          });
        }
      }

      throw error;
    }

    let stkResult;

    try {
      stkResult = await initiateStkPush({
        phoneNumber,
        amountKes: purchase.expectedAmountKes,
        accountReference: purchase._id.toString(),
        transactionDesc: "PTW membership"
      });
    } catch (error) {
      /*
       * A timeout can happen after the provider accepts the request.
       * Never automatically issue another STK prompt for this purchase.
       */
      await MembershipPurchase.updateOne(
        { _id: purchase._id, paymentStatus: "pending" },
        {
          $set: {
            paymentStatus: "verification_required",
            failureCode: error.code || "STK_OUTCOME_UNKNOWN",
            failureDescription:
              "STK initiation outcome is uncertain. Reconciliation is required."
          }
        }
      );

      console.error(
        "Membership STK initiation needs reconciliation:",
        error.code || error.message
      );

      return res.status(202).json({
        success: true,
        code: "RECONCILIATION_REQUIRED",
        message:
          "The payment request outcome is uncertain. Do not start another purchase until it is reconciled.",
        purchase: {
          purchaseReference: purchase.purchaseReference,
          paymentStatus: "verification_required",
          amount: Number((purchase.priceCents / 100).toFixed(2)),
          currency: "USD",
          expectedAmountKes: purchase.expectedAmountKes
        }
      });
    }

    if (stkResult.mode !== "live") {
      await MembershipPurchase.updateOne(
        { _id: purchase._id, paymentStatus: "pending" },
        {
          $set: {
            paymentStatus: "verification_required",
            failureCode: "DARAJA_NOT_AVAILABLE",
            failureDescription:
              "No confirmed STK initiation. Reconciliation is required before retrying."
          }
        }
      );

      return res.status(503).json({
        success: false,
        code: "DARAJA_NOT_AVAILABLE",
        message: "The payment provider did not initiate a confirmed request.",
        purchaseReference: purchase.purchaseReference
      });
    }

    if (!stkResult.accepted) {
      await MembershipPurchase.updateOne(
        { _id: purchase._id, paymentStatus: "pending" },
        {
          $set: {
            paymentStatus: "failed",
            failureCode: String(stkResult.responseCode || "STK_REJECTED")
              .slice(0, 80),
            failureDescription: String(
              stkResult.responseDescription ||
              "Daraja did not accept the STK request."
            ).slice(0, 500)
          }
        }
      );

      return res.status(502).json({
        success: false,
        code: "STK_REJECTED",
        message: "Daraja did not accept the payment request.",
        purchaseReference: purchase.purchaseReference
      });
    }

    if (
      typeof stkResult.checkoutRequestId !== "string" ||
      !stkResult.checkoutRequestId ||
      typeof stkResult.merchantRequestId !== "string" ||
      !stkResult.merchantRequestId
    ) {
      await MembershipPurchase.updateOne(
        { _id: purchase._id, paymentStatus: "pending" },
        {
          $set: {
            paymentStatus: "verification_required",
            failureCode: "STK_IDENTIFIERS_MISSING",
            failureDescription:
              "Provider response lacked request identifiers. Reconciliation is required."
          }
        }
      );

      return res.status(202).json({
        success: true,
        code: "RECONCILIATION_REQUIRED",
        message: "The provider response requires reconciliation.",
        purchaseReference: purchase.purchaseReference
      });
    }

    try {
      const persistResult = await MembershipPurchase.updateOne(
        {
          _id: purchase._id,
          paymentStatus: "pending",
          checkoutRequestId: null
        },
        {
          $set: {
            checkoutRequestId: stkResult.checkoutRequestId,
            merchantRequestId: stkResult.merchantRequestId
          }
        },
        { runValidators: true }
      );

      if (persistResult.matchedCount !== 1) {
        /*
         * The provider may have accepted the prompt, but we could not
         * confirm that its identifiers were saved to this purchase.
         * Do not retry the STK request automatically.
         */
        await MembershipPurchase.updateOne(
          { _id: purchase._id, paymentStatus: "pending" },
          {
            $set: {
              paymentStatus: "verification_required",
              failureCode: "CHECKOUT_PERSISTENCE_UNCONFIRMED",
              failureDescription:
                "Provider accepted the request, but checkout identifiers could not be confirmed in storage."
            }
          }
        );

        return res.status(202).json({
          success: true,
          code: "RECONCILIATION_REQUIRED",
          message:
            "The payment request needs reconciliation. Do not initiate another prompt.",
          purchaseReference: purchase.purchaseReference
        });
      }
    } catch (error) {
      /*
       * A checkout-ID collision or database error must not cause
       * a second purchase to be activated or another prompt sent.
       */
      await MembershipPurchase.updateOne(
        { _id: purchase._id, paymentStatus: "pending" },
        {
          $set: {
            paymentStatus: "verification_required",
            failureCode: "CHECKOUT_ID_CONFLICT",
            failureDescription:
              "Checkout identifiers could not be safely recorded. Reconciliation is required."
          }
        }
      );

      console.error(
        "Membership checkout identifier persistence failed:",
        error.code || error.message
      );

      return res.status(202).json({
        success: true,
        code: "RECONCILIATION_REQUIRED",
        message: "The payment request requires reconciliation.",
        purchaseReference: purchase.purchaseReference
      });
    }

    const saved = await MembershipPurchase.findById(purchase._id).lean();

    return res.status(202).json({
      success: true,
      message:
        "STK request accepted. Membership activation awaits independent payment verification.",
      purchase: serializePurchase(saved)
    });
  } catch (error) {
    console.error("Membership purchase initiation error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not initiate the membership purchase."
    });
  }
});


/*
 * POST /api/membership/purchases/wallet
 *
 * Charges the authenticated user's USD wallet and fulfils the
 * membership atomically. This route does not call Daraja.
 *
 * Headers:
 *   Idempotency-Key: unique client-generated request key
 *
 * Body:
 *   { "planId": "..." }
 */
router.post("/purchases/wallet", async (req, res) => {
  try {
    const idempotencyKey = req.get("Idempotency-Key");

    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 150 ||
      !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_IDEMPOTENCY_KEY",
        message: "A valid Idempotency-Key header is required."
      });
    }

    const { planId } = req.body || {};

    if (
      typeof planId !== "string" ||
      !mongoose.isValidObjectId(planId)
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_PLAN",
        message: "Select a valid membership plan."
      });
    }

    // Check idempotency before reading mutable plan configuration.
    const existing = await MembershipPurchase.findOne({
      purchaserUserId: req.user._id,
      idempotencyKey
    }).lean();

    if (existing) {
      if (
        String(existing.planId) !== planId ||
        existing.paymentMethod !== "wallet"
      ) {
        return res.status(409).json({
          success: false,
          code: "IDEMPOTENCY_CONFLICT",
          message: "This key was already used for different purchase details."
        });
      }

      const failedForBalance =
        existing.paymentStatus === "failed" &&
        existing.failureCode === "INSUFFICIENT_WALLET_BALANCE";

      return res.status(200).json({
        success: true,
        reused: true,
        code: failedForBalance ? "INSUFFICIENT_WALLET_BALANCE" : undefined,
        message: failedForBalance
          ? "This purchase failed because the wallet balance was insufficient. Fund the wallet and create a new purchase with a new Idempotency-Key."
          : "This wallet purchase already exists. No additional debit was requested.",
        purchase: serializePurchase(existing)
      });
    }

    const plan = await MembershipPlan.findOne({
      _id: planId,
      active: true
    })
      .select(
        "key name priceCents durationDays services commissionEnabled commissionAmountsCents"
      )
      .lean();

    if (!plan) {
      return res.status(404).json({
        success: false,
        code: "PLAN_UNAVAILABLE",
        message: "This membership plan is unavailable for purchase."
      });
    }

    const commissionAmounts = plan.commissionAmountsCents;
    const commissionTotal = Array.isArray(commissionAmounts)
      ? commissionAmounts.reduce((sum, amount) => sum + amount, 0)
      : NaN;

    if (
      !Number.isSafeInteger(plan.priceCents) ||
      plan.priceCents < 1 ||
      !Number.isSafeInteger(plan.durationDays) ||
      plan.durationDays < 1 ||
      !Array.isArray(plan.services) ||
      !Array.isArray(commissionAmounts) ||
      commissionAmounts.length !== 4 ||
      !commissionAmounts.every(
        amount => Number.isSafeInteger(amount) && amount >= 0
      ) ||
      !Number.isSafeInteger(commissionTotal) ||
      (
        plan.commissionEnabled === true &&
        commissionTotal > plan.priceCents
      )
    ) {
      return res.status(409).json({
        success: false,
        code: "INVALID_PLAN_CONFIGURATION",
        message: "The plan configuration needs administrator review."
      });
    }

    let purchase;

    try {
      purchase = await MembershipPurchase.create({
        idempotencyKey,
        purchaserUserId: req.user._id,
        planId: plan._id,
        planKey: plan.key,
        paymentMethod: "wallet",
        priceCents: plan.priceCents,
        currency: "USD",
        expectedAmountKes: undefined,
        durationDays: plan.durationDays,
        services: plan.services,
        commissionEnabledSnapshot: plan.commissionEnabled === true,
        commissionAmountsCentsSnapshot: commissionAmounts.slice(),
        paymentStatus: "pending"
      });
    } catch (error) {
      if (error.code === 11000) {
        const concurrent = await MembershipPurchase.findOne({
          purchaserUserId: req.user._id,
          idempotencyKey
        }).lean();

        if (concurrent) {
          if (
            String(concurrent.planId) !== planId ||
            concurrent.paymentMethod !== "wallet"
          ) {
            return res.status(409).json({
              success: false,
              code: "IDEMPOTENCY_CONFLICT",
              message: "This key was already used for different purchase details."
            });
          }

          return res.status(200).json({
            success: true,
            reused: true,
            message: "This wallet purchase already exists.",
            purchase: serializePurchase(concurrent)
          });
        }
      }

      throw error;
    }

    let fulfilment;

    try {
      fulfilment = await fulfilMembershipPurchase(purchase._id, {
        paymentMethod: "wallet"
      });
    } catch (error) {
      if (error.code === "INSUFFICIENT_WALLET_BALANCE") {
        await MembershipPurchase.updateOne(
          {
            _id: purchase._id,
            paymentMethod: "wallet",
            paymentStatus: "pending",
            membershipId: null
          },
          {
            $set: {
              paymentStatus: "failed",
              failureCode: "INSUFFICIENT_WALLET_BALANCE",
              failureDescription:
                "The USD wallet balance was insufficient. Use a new idempotency key to retry after funding."
            }
          }
        );

        return res.status(402).json({
          success: false,
          code: "INSUFFICIENT_WALLET_BALANCE",
          message: "Your wallet balance is insufficient for this membership.",
          purchaseReference: purchase.purchaseReference,
          amount: Number((purchase.priceCents / 100).toFixed(2)),
          currency: "USD"
        });
      }

      throw error;
    }

    const saved = await MembershipPurchase.findById(purchase._id).lean();

    return res.status(201).json({
      success: true,
      message: "Membership purchased and activated using your USD wallet.",
      purchase: serializePurchase(saved),
      membership: {
        id: fulfilment.membershipId,
        startsAt: fulfilment.startsAt,
        expiresAt: fulfilment.expiresAt
      },
      commissionsCreated: fulfilment.commissionsCreated,
      totalCommission: Number(
        (fulfilment.totalCommissionCents / 100).toFixed(2)
      ),
      currency: "USD"
    });
  } catch (error) {
    console.error(
      "Wallet membership purchase error:",
      error.code || error.message
    );

    return res.status(500).json({
      success: false,
      message: "Could not complete the wallet membership purchase."
    });
  }
});

function serializePurchase(purchase) {
  return {
    purchaseReference: purchase.purchaseReference,
    planKey: purchase.planKey,
    amount: Number((purchase.priceCents / 100).toFixed(2)),
    currency: "USD",
    paymentMethod: purchase.paymentMethod || "daraja",
    expectedAmountKes: purchase.expectedAmountKes ?? null,
    paymentStatus: purchase.paymentStatus,
    checkoutRequestId: purchase.checkoutRequestId || null,
    createdAt: purchase.createdAt
  };
}


module.exports = router;
