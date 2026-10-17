"use strict";

const express = require("express");
const requireAuth = require("../middleware/requireAuth");

const User = require("../models/User");
const Membership = require("../models/Membership");
const MembershipPlan = require("../models/MembershipPlan");
const MembershipPurchase = require("../models/MembershipPurchase");
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

router.get("/", async (req, res) => {
  try {
    const [
      totalUsers,
      activeUsers,
      suspendedUsers,
      adminUsers,
      activeMemberships,
      totalMembershipPlans,
      activeMembershipPlans,
      pendingDeposits,
      pendingPurchases,
      verifiedPurchasesAwaitingFulfilment,
      withdrawalsAwaitingReview,
      latestDeposits,
      latestPurchases,
      latestVerifiedPurchases,
      latestWithdrawals
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ status: "active" }),
      User.countDocuments({ status: "suspended" }),
      User.countDocuments({ role: { $in: ["admin", "founder"] } }),
      Membership.countDocuments({ status: "active" }),
      MembershipPlan.countDocuments({}),
      MembershipPlan.countDocuments({ active: true }),
      Deposit.countDocuments({ status: "pending" }),
      MembershipPurchase.countDocuments({
        paymentStatus: {
          $in: ["pending", "verification_required"]
        }
      }),
      MembershipPurchase.countDocuments({
        paymentStatus: "verified",
        membershipId: null,
        activatedAt: null
      }),
      Withdrawal.countDocuments({ status: "pending_review" }),
      Deposit.find({ status: "pending" })
        .sort({ createdAt: 1 })
        .limit(8)
        .select("requestId userId amountCents currency expectedAmountKes phoneNumber status createdAt")
        .populate("userId", "firstName lastName username email")
        .lean(),
      MembershipPurchase.find({
        paymentStatus: {
          $in: ["pending", "verification_required"]
        }
      })
        .sort({ createdAt: 1 })
        .limit(8)
        .select("purchaseReference purchaserUserId planKey priceCents currency expectedAmountKes paymentStatus createdAt")
        .populate("purchaserUserId", "firstName lastName username email")
        .lean(),
      MembershipPurchase.find({
        paymentStatus: "verified",
        membershipId: null,
        activatedAt: null
      })
        .sort({ verifiedAt: 1, createdAt: 1 })
        .limit(8)
        .select("purchaseReference purchaserUserId planKey priceCents currency expectedAmountKes paymentStatus commissionEnabledSnapshot createdAt")
        .populate("purchaserUserId", "firstName lastName username email")
        .lean(),
      Withdrawal.find({ status: "pending_review" })
        .sort({ createdAt: 1 })
        .limit(8)
        .select("requestId userId amountCents currency phoneNumber status createdAt")
        .populate("userId", "firstName lastName username email")
        .lean()
    ]);

    return res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      admin: {
        id: String(req.user._id),
        name: [req.user.firstName, req.user.lastName]
          .filter(Boolean)
          .join(" "),
        username: req.user.username,
        role: req.user.role
      },
      stats: {
        totalUsers,
        activeUsers,
        suspendedUsers,
        adminUsers,
        activeMemberships,
        totalMembershipPlans,
        activeMembershipPlans,
        pendingDeposits,
        pendingPurchases,
        verifiedPurchasesAwaitingFulfilment,
        withdrawalsAwaitingReview
      },
      queues: {
        deposits: latestDeposits,
        membershipPurchases: latestPurchases,
        membershipPurchasesAwaitingFulfilment: latestVerifiedPurchases,
        withdrawals: latestWithdrawals
      }
    });
  } catch (error) {
    console.error("Admin overview error:", error.message);

    return res.status(500).json({
      success: false,
      message: "The admin overview could not be loaded."
    });
  }
});

module.exports = router;
