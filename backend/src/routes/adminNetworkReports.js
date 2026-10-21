"use strict";

const express = require("express");
const mongoose = require("mongoose");

const requireAuth = require("../middleware/requireAuth");
const User = require("../models/User");
const Commission = require("../models/Commission");
const WalletTransaction = require("../models/WalletTransaction");
const Deposit = require("../models/Deposit");
const Withdrawal = require("../models/Withdrawal");
const AdminAuditLog = require("../models/AdminAuditLog");

const router = express.Router();

router.use(requireAuth);

router.use((req, res, next) => {
  if (!["admin", "founder"].includes(req.user?.role)) {
    return res.status(403).json({
      success: false,
      message: "Administrator access required."
    });
  }

  next();
});

function pagination(req) {
  const page = Math.max(1, Math.min(1000000, Number.parseInt(req.query.page, 10) || 1));
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 25));

  return {
    page,
    limit,
    skip: (page - 1) * limit
  };
}

function usd(cents) {
  return Number((Number(cents || 0) / 100).toFixed(2));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function matchingUserIds(search) {
  if (!search) return null;

  const regex = new RegExp(escapeRegex(search), "i");
  const users = await User.find({
    $or: [
      { username: regex },
      { firstName: regex },
      { lastName: regex },
      { email: regex }
    ]
  }).select("_id").limit(500).lean();

  return users.map(user => user._id);
}

function sendError(res, error, label) {
  console.error(`${label}:`, error.message);

  return res.status(500).json({
    success: false,
    message: `Unable to load ${label.toLowerCase()}.`
  });
}

function pageResponse(data, total, page, limit) {
  return {
    success: true,
    data,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
}

// GET /api/admin/reports/commissions
router.get("/commissions", async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req);
    const filter = {};

    if (["pending", "paid", "reversed"].includes(req.query.status)) {
      filter.status = req.query.status;
    }

    if (req.query.level !== undefined && req.query.level !== "") {
      const level = Number(req.query.level);

      if (!Number.isInteger(level) || level < 1 || level > 4) {
        return res.status(400).json({
          success: false,
          message: "Level must be an integer from 1 to 4."
        });
      }

      filter.level = level;
    }

    const search = String(req.query.search || "").trim().slice(0, 100);
    const ids = await matchingUserIds(search);

    if (ids && ids.length === 0) {
      return res.json(pageResponse([], 0, page, limit));
    }

    if (ids) {
      filter.$or = [
        { beneficiaryUserId: { $in: ids } },
        { purchaserUserId: { $in: ids } }
      ];
    }

    const [rows, total] = await Promise.all([
      Commission.find(filter)
        .populate("beneficiaryUserId", "username firstName lastName")
        .populate("purchaserUserId", "username firstName lastName")
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Commission.countDocuments(filter)
    ]);

    const data = rows.map(row => ({
      id: row._id,
      beneficiary: row.beneficiaryUserId || null,
      purchaser: row.purchaserUserId || null,
      membershipId: row.membershipId,
      level: row.level,
      amountUsd: usd(row.amountCents),
      currency: row.currency,
      status: row.status,
      walletTransactionId: row.walletTransactionId,
      createdAt: row.createdAt,
      paidAt: row.paidAt,
      reversedAt: row.reversedAt
    }));

    return res.json(pageResponse(data, total, page, limit));
  } catch (error) {
    return sendError(res, error, "Commissions");
  }
});

// GET /api/admin/reports/referrals
// Lists members with their direct sponsor and direct-referral count.
router.get("/referrals", async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req);
    const filter = {};
    const search = String(req.query.search || "").trim().slice(0, 100);
    const ids = await matchingUserIds(search);

    if (ids && ids.length === 0) {
      return res.json(pageResponse([], 0, page, limit));
    }

    if (ids) filter._id = { $in: ids };

    if (["active", "suspended"].includes(req.query.status)) {
      filter.status = req.query.status;
    }

    const [members, total] = await Promise.all([
      User.find(filter)
        .select("_id username firstName lastName status referredBy createdAt")
        .populate("referredBy", "username firstName lastName")
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter)
    ]);

    const memberIds = members.map(member => member._id);
    const counts = memberIds.length
      ? await User.aggregate([
          { $match: { referredBy: { $in: memberIds } } },
          { $group: { _id: "$referredBy", count: { $sum: 1 } } }
        ])
      : [];

    const countBySponsor = new Map(
      counts.map(item => [String(item._id), item.count])
    );

    const data = members.map(member => ({
      id: member._id,
      username: member.username,
      firstName: member.firstName,
      lastName: member.lastName,
      status: member.status,
      sponsor: member.referredBy || null,
      directReferrals: countBySponsor.get(String(member._id)) || 0,
      joinedAt: member.createdAt
    }));

    return res.json(pageResponse(data, total, page, limit));
  } catch (error) {
    return sendError(res, error, "Referrals");
  }
});

// GET /api/admin/reports/transactions
router.get("/transactions", async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req);
    const filter = {};

    const validTypes = [
      "deposit", "withdrawal", "transfer_in", "transfer_out",
      "earning", "commission", "adjustment"
    ];
    const validStatuses = ["pending", "completed", "failed", "reversed"];

    if (validTypes.includes(req.query.type)) filter.type = req.query.type;
    if (validStatuses.includes(req.query.status)) filter.status = req.query.status;

    const search = String(req.query.search || "").trim().slice(0, 100);
    const ids = await matchingUserIds(search);

    if (ids && ids.length === 0) {
      return res.json(pageResponse([], 0, page, limit));
    }

    if (ids) filter.userId = { $in: ids };

    const [rows, total] = await Promise.all([
      WalletTransaction.find(filter)
        .populate("userId", "username firstName lastName")
        .populate("relatedUserId", "username firstName lastName")
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WalletTransaction.countDocuments(filter)
    ]);

    const data = rows.map(row => ({
      id: row._id,
      user: row.userId || null,
      relatedUser: row.relatedUserId || null,
      type: row.type,
      amountUsd: usd(row.amountCents),
      currency: row.currency,
      status: row.status,
      reference: row.reference,
      description: row.description,
      depositId: row.depositId,
      commissionId: row.commissionId,
      createdAt: row.createdAt,
      completedAt: row.completedAt
    }));

    return res.json(pageResponse(data, total, page, limit));
  } catch (error) {
    return sendError(res, error, "Transactions");
  }
});

// GET /api/admin/reports/deposits
router.get("/deposits", async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req);
    const filter = {};

    if (["pending", "completed", "failed", "cancelled"].includes(req.query.status)) {
      filter.status = req.query.status;
    }

    const search = String(req.query.search || "").trim().slice(0, 100);
    const ids = await matchingUserIds(search);

    if (ids && ids.length === 0) {
      return res.json(pageResponse([], 0, page, limit));
    }

    if (ids) filter.userId = { $in: ids };

    const [rows, total] = await Promise.all([
      Deposit.find(filter)
        .populate("userId", "username firstName lastName")
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Deposit.countDocuments(filter)
    ]);

    const data = rows.map(row => ({
      id: row._id,
      requestId: row.requestId,
      user: row.userId || null,
      amountUsd: usd(row.amountCents),
      currency: row.currency,
      paymentMode: row.paymentMode || "daraja",
      expectedAmountKes: row.expectedAmountKes,
      status: row.status,
      phoneNumber: row.phoneNumber,
      mpesaReceipt: row.mpesaReceipt,
      checkoutRequestId: row.checkoutRequestId,
      walletTransactionId: row.walletTransactionId,
      createdAt: row.createdAt,
      completedAt: row.completedAt
    }));

    return res.json(pageResponse(data, total, page, limit));
  } catch (error) {
    return sendError(res, error, "Deposits");
  }
});

// GET /api/admin/reports/withdrawals
router.get("/withdrawals", async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req);
    const filter = {};

    if (["pending_review", "approved", "paid", "rejected"].includes(req.query.status)) {
      filter.status = req.query.status;
    }

    const search = String(req.query.search || "").trim().slice(0, 100);
    const ids = await matchingUserIds(search);

    if (ids && ids.length === 0) {
      return res.json(pageResponse([], 0, page, limit));
    }

    if (ids) filter.userId = { $in: ids };

    const [rows, total] = await Promise.all([
      Withdrawal.find(filter)
        .populate("userId", "username firstName lastName")
        .populate("reviewedBy", "username firstName lastName")
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Withdrawal.countDocuments(filter)
    ]);

    const data = rows.map(row => ({
      id: row._id,
      requestId: row.requestId,
      user: row.userId || null,
      amountUsd: usd(row.amountCents),
      currency: row.currency,
      status: row.status,
      phoneNumber: row.phoneNumber,
      mpesaReceipt: row.mpesaReceipt,
      transactionId: row.transactionId,
      reviewedBy: row.reviewedBy || null,
      reviewedAt: row.reviewedAt,
      adminNote: row.adminNote,
      createdAt: row.createdAt
    }));

    return res.json(pageResponse(data, total, page, limit));
  } catch (error) {
    return sendError(res, error, "Withdrawals");
  }
});

// GET /api/admin/reports/audit-logs
router.get("/audit-logs", async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req);
    const filter = {};
    const search = String(req.query.search || "").trim().slice(0, 100);
    const ids = await matchingUserIds(search);

    if (ids && ids.length === 0) {
      return res.json(pageResponse([], 0, page, limit));
    }

    if (ids) {
      filter.$or = [
        { adminId: { $in: ids } },
        { targetUserId: { $in: ids } }
      ];
    }

    if (req.query.action) {
      filter.action = String(req.query.action).trim().slice(0, 80);
    }

    const [rows, total] = await Promise.all([
      AdminAuditLog.find(filter)
        .populate("adminId", "username firstName lastName role")
        .populate("targetUserId", "username firstName lastName")
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AdminAuditLog.countDocuments(filter)
    ]);

    const data = rows.map(row => ({
      id: row._id,
      admin: row.adminId || null,
      targetUser: row.targetUserId || null,
      action: row.action,
      reason: row.reason,
      before: row.before,
      after: row.after,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt
    }));

    return res.json(pageResponse(data, total, page, limit));
  } catch (error) {
    return sendError(res, error, "Audit logs");
  }
});

module.exports = router;
