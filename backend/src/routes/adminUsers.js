"use strict";

const express = require("express");
const mongoose = require("mongoose");
const requireAuth = require("../middleware/requireAuth");

const User = require("../models/User");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const Membership = require("../models/Membership");
const MembershipPlan = require("../models/MembershipPlan");
const MembershipPurchase = require("../models/MembershipPurchase");
const Withdrawal = require("../models/Withdrawal");
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

const usd = cents => Number((Number(cents || 0) / 100).toFixed(2));

function safeUser(user) {
  if (!user) return null;

  return {
    id: String(user._id),
    firstName: user.firstName,
    lastName: user.lastName,
    fullName: [user.firstName, user.lastName].filter(Boolean).join(" "),
    username: user.username,
    email: user.email,
    phone: user.phone,
    profilePictureUrl: user.profilePictureUrl || null,
    selectedService: user.selectedService || null,
    role: user.role,
    status: user.status,
    emailVerified: Boolean(user.emailVerified),
    sponsor: user.referredBy ? {
      id: String(user.referredBy._id || user.referredBy),
      username: user.referredBy.username || null,
      firstName: user.referredBy.firstName || null,
      lastName: user.referredBy.lastName || null
    } : null,
    lastLoginAt: user.lastLoginAt || null,
    joinedAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function validId(id) {
  return mongoose.isValidObjectId(id);
}

/*
 * GET /api/admin/users
 * Supports q, status, membership, page, and limit.
 */
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 25)
    );
    const q = String(req.query.q || "").trim().slice(0, 120);
    const filter = {};

    if (["active", "suspended"].includes(req.query.status)) {
      filter.status = req.query.status;
    }

    if (q) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "i");
      filter.$or = [
        { firstName: regex },
        { lastName: regex },
        { username: regex },
        { email: regex },
        { phone: regex }
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select(
          "firstName lastName username email phone role status emailVerified selectedService referredBy lastLoginAt createdAt updatedAt"
        )
        .populate("referredBy", "username firstName lastName")
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(filter)
    ]);

    const ids = users.map(user => user._id);

    const [wallets, memberships] = await Promise.all([
      Wallet.find({ userId: { $in: ids } }).lean(),
      Membership.find({ userId: { $in: ids } })
        .populate("planId", "name key priceCents currency")
        .sort({ createdAt: -1 })
        .lean()
    ]);

    const walletByUser = new Map(
      wallets.map(wallet => [String(wallet.userId), wallet])
    );
    const membershipByUser = new Map();
    const now = Date.now();

    const isCurrentMembership = membership =>
      membership.status === "active" &&
      membership.startsAt &&
      membership.expiresAt &&
      new Date(membership.startsAt).getTime() <= now &&
      new Date(membership.expiresAt).getTime() > now;

    for (const membership of memberships) {
      const key = String(membership.userId);
      const existing = membershipByUser.get(key);

      if (!existing) {
        membershipByUser.set(key, membership);
        continue;
      }

      const candidateIsCurrent = isCurrentMembership(membership);
      const existingIsCurrent = isCurrentMembership(existing);

      if (
        (candidateIsCurrent && !existingIsCurrent) ||
        (
          candidateIsCurrent &&
          existingIsCurrent &&
          new Date(membership.expiresAt).getTime() >
            new Date(existing.expiresAt).getTime()
        )
      ) {
        membershipByUser.set(key, membership);
      }
    }

    const rows = users.map(user => {
      const wallet = walletByUser.get(String(user._id));
      const membership = membershipByUser.get(String(user._id));

      return {
        ...safeUser(user),
        wallet: {
          currency: "USD",
          availableBalance: usd(wallet?.availableBalanceCents),
          pendingEarnings: usd(wallet?.pendingEarningsCents),
          totalEarnings: usd(wallet?.totalEarningsCents),
          totalWithdrawals: usd(wallet?.totalWithdrawalsCents)
        },
        membership: membership ? {
          id: String(membership._id),
          status: membership.status,
          plan: membership.planId?.name || membership.planKey,
          planKey: membership.planKey,
          startsAt: membership.startsAt,
          expiresAt: membership.expiresAt,
          activatedAt: membership.activatedAt,
          grantSource: membership.grantSource || "purchase",
          grantReason: membership.grantReason || ""
        } : null
      };
    });

    return res.json({
      success: true,
      data: rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error("Admin users list error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load users."
    });
  }
});

/*
 * GET /api/admin/users/:id
 * Returns profile, wallet, membership history, transactions,
 * withdrawals, and administrative audit history.
 */
router.get("/:id", async (req, res) => {
  try {
    if (!validId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID."
      });
    }

    const user = await User.findById(req.params.id)
      .select(
        "firstName lastName username email phone profilePictureUrl selectedService referredBy role status emailVerified lastLoginAt createdAt updatedAt"
      )
      .populate("referredBy", "username firstName lastName email")
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found."
      });
    }

    const [
      wallet,
      memberships,
      transactions,
      withdrawals,
      purchases,
      auditLogs
    ] = await Promise.all([
      Wallet.findOne({ userId: user._id }).lean(),
      Membership.find({ userId: user._id })
        .populate("planId", "name key priceCents currency")
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      WalletTransaction.find({ userId: user._id })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
      Withdrawal.find({ userId: user._id })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      MembershipPurchase.find({ purchaserUserId: user._id })
        .select(
          "purchaseReference planKey priceCents currency expectedAmountKes paymentStatus mpesaReceipt createdAt verifiedAt activatedAt"
        )
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      AdminAuditLog.find({ targetUserId: user._id })
        .populate("adminId", "username firstName lastName")
        .sort({ createdAt: -1 })
        .limit(100)
        .lean()
    ]);

    return res.json({
      success: true,
      data: {
        user: safeUser(user),
        wallet: {
          currency: "USD",
          availableBalance: usd(wallet?.availableBalanceCents),
          pendingEarnings: usd(wallet?.pendingEarningsCents),
          totalEarnings: usd(wallet?.totalEarningsCents),
          totalWithdrawals: usd(wallet?.totalWithdrawalsCents)
        },
        memberships,
        transactions: transactions.map(transaction => ({
          ...transaction,
          amount: usd(transaction.amountCents),
          currency: "USD"
        })),
        withdrawals: withdrawals.map(withdrawal => ({
          ...withdrawal,
          amount: usd(withdrawal.amountCents),
          currency: "USD"
        })),
        membershipPurchases: purchases.map(purchase => ({
          ...purchase,
          price: usd(purchase.priceCents),
          currency: "USD"
        })),
        auditLogs
      }
    });
  } catch (error) {
    console.error("Admin user profile error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load this user profile."
    });
  }
});

/*
 * PATCH /api/admin/users/:id
 * Editable identity/account fields only.
 * Role changes are intentionally excluded from this endpoint.
 */
router.patch("/:id", async (req, res) => {
  try {
    if (!validId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID."
      });
    }

    const reason = String(req.body.reason || "").trim();
    if (reason.length < 5 || reason.length > 500) {
      return res.status(400).json({
        success: false,
        message: "Provide an audit reason between 5 and 500 characters."
      });
    }

    const allowed = ["firstName", "lastName", "email", "phone", "status", "selectedService"];
    const updates = {};

    for (const field of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        updates[field] = req.body[field];
      }
    }

    for (const field of ["firstName", "lastName"]) {
      if (field in updates) {
        if (typeof updates[field] !== "string" ||
            !updates[field].trim() ||
            updates[field].trim().length > 60) {
          return res.status(400).json({
            success: false,
            message: `${field} must contain 1 to 60 characters.`
          });
        }
        updates[field] = updates[field].trim();
      }
    }

    if ("email" in updates) {
      if (typeof updates.email !== "string" ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.email.trim()) ||
          updates.email.trim().length > 254) {
        return res.status(400).json({
          success: false,
          message: "Enter a valid email address."
        });
      }
      updates.email = updates.email.trim().toLowerCase();
    }

    if ("phone" in updates) {
      if (typeof updates.phone !== "string" ||
          !updates.phone.trim() ||
          updates.phone.trim().length > 25) {
        return res.status(400).json({
          success: false,
          message: "Enter a valid phone number."
        });
      }
      updates.phone = updates.phone.trim();
    }

    if ("status" in updates &&
        !["active", "suspended"].includes(updates.status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be active or suspended."
      });
    }

    if ("selectedService" in updates &&
        ![null, "", "transcription", "note-taking", "data-entry", "academic-writing"].includes(updates.selectedService)) {
      return res.status(400).json({
        success: false,
        message: "Invalid selected service."
      });
    }

    if ("selectedService" in updates && updates.selectedService === "") {
      updates.selectedService = null;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        success: false,
        message: "No supported fields were supplied."
      });
    }

    const existing = await User.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "User not found."
      });
    }

    if (String(existing._id) === String(req.user._id) &&
        updates.status === "suspended") {
      return res.status(400).json({
        success: false,
        message: "You cannot suspend your own admin account here."
      });
    }

    const sponsorIdentifierProvided =
      Object.prototype.hasOwnProperty.call(req.body, "sponsorIdentifier");

    let newSponsorId = existing.referredBy || null;

    if (sponsorIdentifierProvided) {
      if (typeof req.body.sponsorIdentifier !== "string" ||
          req.body.sponsorIdentifier.trim().length > 254) {
        return res.status(400).json({
          success: false,
          message: "Sponsor must be a username, email, user ID, or blank to clear."
        });
      }

      const identifier = req.body.sponsorIdentifier.trim().toLowerCase();

      if (!identifier) {
        newSponsorId = null;
      } else {
        const conditions = [
          { username: identifier },
          { email: identifier }
        ];
        if (validId(identifier)) conditions.push({ _id: identifier });

        const sponsor = await User.findOne({ $or: conditions })
          .select("_id username email status");

        if (!sponsor) {
          return res.status(404).json({
            success: false,
            message: "Sponsor account was not found."
          });
        }

        if (String(sponsor._id) === String(existing._id)) {
          return res.status(400).json({
            success: false,
            message: "A user cannot sponsor themselves."
          });
        }

        if (sponsor.status !== "active") {
          return res.status(400).json({
            success: false,
            message: "Choose an active sponsor account."
          });
        }

        // Walk upward from the proposed sponsor. The target user must
        // never appear in that chain, or the reassignment creates a cycle.
        const visited = new Set();
        let cursor = sponsor._id;

        for (let depth = 0; cursor && depth < 1000; depth++) {
          const cursorId = String(cursor);

          if (cursorId === String(existing._id)) {
            return res.status(400).json({
              success: false,
              message: "This sponsor change would create a referral cycle."
            });
          }

          if (visited.has(cursorId)) {
            return res.status(409).json({
              success: false,
              message: "The proposed sponsor chain already contains a cycle."
            });
          }

          visited.add(cursorId);

          const ancestor = await User.findById(cursor)
            .select("_id referredBy")
            .lean();

          if (!ancestor) break;
          cursor = ancestor.referredBy || null;

          if (depth === 999 && cursor) {
            return res.status(409).json({
              success: false,
              message: "Sponsor chain exceeds the allowed validation depth."
            });
          }
        }

        newSponsorId = sponsor._id;
      }

      updates.referredBy = newSponsorId;
    }

    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        const current = await User.findById(existing._id).session(session);

        if (!current) {
          const error = new Error("User not found.");
          error.statusCode = 404;
          throw error;
        }

        const before = {};
        for (const key of Object.keys(updates)) {
          before[key] = current[key];
        }

        Object.assign(current, updates);
        await current.save({ session });

        await AdminAuditLog.create([{
          adminId: req.user._id,
          targetUserId: current._id,
          action: "user.profile.updated",
          reason,
          before,
          after: updates,
          ipAddress: req.ip
        }], { session });
      });
    } finally {
      await session.endSession();
    }

    return res.json({
      success: true,
      message: "User profile updated.",
      data: safeUser(await User.findById(existing._id)
        .populate("referredBy", "username firstName lastName")
        .lean())
    });
  } catch (error) {
    if (error.statusCode === 404) {
      return res.status(404).json({
        success: false,
        message: "User not found."
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "That email address is already used by another account."
      });
    }

    if (
      error.code === 20 ||
      /transactions are not supported|Transaction numbers are only allowed|replica set/i.test(error.message || "")
    ) {
      return res.status(503).json({
        success: false,
        message: "This operation requires MongoDB transaction support. Configure a replica set and retry."
      });
    }

    console.error("Admin user update error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to update this user."
    });
  }
});

/*
 * POST /api/admin/users/:id/wallet-adjustment
 * Body: { direction: "credit"|"debit", amount: 12.50, reason: "..." }
 * Amount is USD; ledger stores integer cents.
 */

router.post("/:id/wallet-adjustment", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid user ID."
    });
  }

  const idempotencyKey = req.get("Idempotency-Key");
  const direction = req.body.direction;
  const amount = Number(req.body.amount);
  const reason = String(req.body.reason || "").trim();
  const amountCents = Math.round(amount * 100);

  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.length < 8 ||
    idempotencyKey.length > 100 ||
    !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)
  ) {
    return res.status(400).json({
      success: false,
      message: "A valid Idempotency-Key header is required."
    });
  }

  if (!["credit", "debit"].includes(direction)) {
    return res.status(400).json({
      success: false,
      message: "Direction must be credit or debit."
    });
  }

  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 10000000 ||
    !Number.isSafeInteger(amountCents) ||
    Math.round(amount * 100) !== amount * 100
  ) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid positive USD amount with no more than two decimal places."
    });
  }

  if (reason.length < 5 || reason.length > 500) {
    return res.status(400).json({
      success: false,
      message: "Provide an audit reason between 5 and 500 characters."
    });
  }

  let session;

  try {
    const user = await User.findById(req.params.id)
      .select("_id username");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found."
      });
    }

    session = await mongoose.startSession();

    let result;

    await session.withTransaction(async () => {
      let wallet = await Wallet.findOne({
        userId: user._id
      }).session(session);

      if (!wallet) {
        const created = await Wallet.create([{
          userId: user._id,
          currency: "USD",
          availableBalanceCents: 0,
          pendingEarningsCents: 0,
          totalEarningsCents: 0,
          totalWithdrawalsCents: 0
        }], { session });

        wallet = created[0];
      }

      if (wallet.currency !== "USD") {
        const error = new Error("Wallet currency integrity error.");
        error.code = "WALLET_CURRENCY";
        throw error;
      }

      const beforeCents = wallet.availableBalanceCents;

      if (!Number.isSafeInteger(beforeCents) || beforeCents < 0) {
        const error = new Error("Wallet balance integrity error.");
        error.code = "WALLET_INTEGRITY";
        throw error;
      }

      const delta = direction === "credit"
        ? amountCents
        : -amountCents;

      const afterCents = beforeCents + delta;

      if (!Number.isSafeInteger(afterCents)) {
        const error = new Error("Wallet balance exceeds safe limits.");
        error.code = "WALLET_INTEGRITY";
        throw error;
      }

      if (afterCents < 0) {
        const error = new Error(
          "Insufficient available balance for this debit."
        );
        error.code = "INSUFFICIENT_BALANCE";
        throw error;
      }

      const updated = await Wallet.findOneAndUpdate(
        {
          _id: wallet._id,
          userId: user._id,
          currency: "USD",
          availableBalanceCents: beforeCents
        },
        {
          $inc: { availableBalanceCents: delta }
        },
        {
          returnDocument: "after",
          runValidators: true,
          session
        }
      );

      if (!updated) {
        const error = new Error("Wallet changed concurrently.");
        error.code = "WALLET_CONFLICT";
        throw error;
      }

      const reference =
        "ADMIN-" + new mongoose.Types.ObjectId().toString();

      await WalletTransaction.create([{
        userId: user._id,
        type: "adjustment",
        amountCents,
        currency: "USD",
        status: "completed",
        createdByAdminId: req.user._id,
        idempotencyKey,
        adjustmentField: "availableBalance",
        adjustmentDirection: direction,
        adjustmentReason: reason,
        adjustmentBeforeCents: beforeCents,
        adjustmentAfterCents: afterCents,
        reference,
        description:
          "Admin " + String(req.user.username || "admin") +
          ": " + direction + ". " + reason +
          ". Balance " + usd(beforeCents) +
          " -> " + usd(afterCents) + " USD.",
        completedAt: new Date()
      }], { session });

      await AdminAuditLog.create([{
        adminId: req.user._id,
        targetUserId: user._id,
        action: "wallet." + direction,
        reason,
        before: {
          availableBalance: usd(beforeCents),
          currency: "USD"
        },
        after: {
          availableBalance: usd(afterCents),
          currency: "USD",
          adjustmentAmount: amount,
          direction
        },
        ipAddress: req.ip
      }], { session });

      result = {
        userId: String(user._id),
        currency: "USD",
        previousBalance: usd(beforeCents),
        adjustmentAmount: amount,
        direction,
        availableBalance: usd(afterCents)
      };
    });

    return res.json({
      success: true,
      message: "Wallet adjustment completed and recorded.",
      data: result
    });
  } catch (error) {
    if (error.code === 11000 && idempotencyKey) {
      try {
        const existing = await WalletTransaction.findOne({
          createdByAdminId: req.user._id,
          idempotencyKey,
          type: "adjustment"
        }).lean();

        if (existing) {
          const sameRequest =
            String(existing.userId) === String(req.params.id) &&
            existing.amountCents === amountCents &&
            existing.adjustmentField === "availableBalance" &&
            existing.adjustmentDirection === direction &&
            existing.adjustmentReason === reason &&
            existing.currency === "USD" &&
            existing.status === "completed" &&
            Number.isSafeInteger(existing.adjustmentBeforeCents) &&
            Number.isSafeInteger(existing.adjustmentAfterCents);

          if (!sameRequest) {
            return res.status(409).json({
              success: false,
              message:
                "This Idempotency-Key was already used for a different adjustment. Use a new key for a new request."
            });
          }

          return res.json({
            success: true,
            message: "This adjustment was already processed. No additional balance change was made.",
            data: {
              userId: String(existing.userId),
              currency: "USD",
              previousBalance: usd(existing.adjustmentBeforeCents),
              adjustmentAmount: usd(existing.amountCents),
              direction: existing.adjustmentDirection,
              availableBalance: usd(existing.adjustmentAfterCents),
              replayed: true
            }
          });
        }
      } catch (lookupError) {
        console.error(
          "Unable to verify existing wallet adjustment:",
          lookupError.message
        );
      }
    }

    console.error("Admin wallet adjustment error:", error.message);

    if (error.code === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    if (
      ["WALLET_CONFLICT", "WALLET_CURRENCY", "WALLET_INTEGRITY"].includes(
        error.code
      ) ||
      error.code === 11000
    ) {
      return res.status(409).json({
        success: false,
        message: "Wallet integrity or concurrency conflict. Refresh and verify the ledger before retrying."
      });
    }

    if (
      error.code === 20 ||
      error.codeName === "IllegalOperation" ||
      /transaction numbers are only allowed|transactions are not supported|replica set member or mongos/i.test(
        error.message || ""
      )
    ) {
      return res.status(503).json({
        success: false,
        message: "Atomic wallet adjustments require MongoDB transaction support. No adjustment was confirmed."
      });
    }

    return res.status(500).json({
      success: false,
      message: "Unable to confirm the wallet adjustment. Verify the wallet and ledger before retrying."
    });
  } finally {
    if (session) {
      try {
        await session.endSession();
      } catch (error) {
        console.error("MongoDB session cleanup error:", error.message);
      }
    }
  }
});


/*
 * POST /api/admin/users/:id/earnings-adjustment
 * Adjusts total earnings only. It does not change spendable balance.
 */
router.post("/:id/earnings-adjustment", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid user ID." });
  }

  const key = req.get("Idempotency-Key");
  const direction = req.body.direction;
  const amount = Number(req.body.amount);
  const amountCents = Math.round(amount * 100);
  const reason = String(req.body.reason || "").trim();

  if (typeof key !== "string" || key.length < 8 || key.length > 100 ||
      !/^[A-Za-z0-9._:-]+$/.test(key)) {
    return res.status(400).json({
      success: false, message: "A valid Idempotency-Key header is required."
    });
  }
  if (!["credit", "debit"].includes(direction)) {
    return res.status(400).json({
      success: false, message: "Direction must be credit or debit."
    });
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000 ||
      !Number.isSafeInteger(amountCents) || amount * 100 !== amountCents) {
    return res.status(400).json({
      success: false,
      message: "Enter a positive USD amount with no more than two decimal places."
    });
  }
  if (reason.length < 5 || reason.length > 500) {
    return res.status(400).json({
      success: false, message: "Provide an audit reason between 5 and 500 characters."
    });
  }

  let session;
  try {
    const user = await User.findById(req.params.id).select("_id username");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    session = await mongoose.startSession();
    let result;

    await session.withTransaction(async () => {
      const existing = await WalletTransaction.findOne({
        createdByAdminId: req.user._id,
        idempotencyKey: key,
        type: "adjustment"
      }).session(session);

      if (existing) {
        const same = String(existing.userId) === String(user._id) &&
          existing.adjustmentField === "totalEarnings" &&
          existing.amountCents === amountCents &&
          existing.adjustmentDirection === direction &&
          existing.adjustmentReason === reason &&
          existing.currency === "USD" && existing.status === "completed";

        if (!same) {
          const error = new Error("Idempotency key already used for another request.");
          error.code = "IDEMPOTENCY_CONFLICT";
          throw error;
        }

        result = {
          userId: String(user._id),
          currency: "USD",
          previousEarnings: usd(existing.adjustmentBeforeCents),
          adjustmentAmount: usd(existing.amountCents),
          direction,
          totalEarnings: usd(existing.adjustmentAfterCents),
          replayed: true
        };
        return;
      }

      let wallet = await Wallet.findOne({ userId: user._id }).session(session);
      if (!wallet) {
        const created = await Wallet.create([{
          userId: user._id,
          currency: "USD",
          availableBalanceCents: 0,
          pendingEarningsCents: 0,
          totalEarningsCents: 0,
          totalWithdrawalsCents: 0
        }], { session });
        wallet = created[0];
      }

      if (wallet.currency !== "USD") {
        const error = new Error("Wallet currency integrity error.");
        error.code = "WALLET_CURRENCY";
        throw error;
      }

      const before = wallet.totalEarningsCents;
      if (!Number.isSafeInteger(before) || before < 0) {
        const error = new Error("Wallet earnings integrity error.");
        error.code = "WALLET_INTEGRITY";
        throw error;
      }

      const delta = direction === "credit" ? amountCents : -amountCents;
      const after = before + delta;
      if (!Number.isSafeInteger(after) || after < 0) {
        const error = new Error("Adjustment would make total earnings invalid.");
        error.code = "INVALID_EARNINGS";
        throw error;
      }

      const updated = await Wallet.findOneAndUpdate(
        {
          _id: wallet._id,
          userId: user._id,
          currency: "USD",
          totalEarningsCents: before
        },
        { $inc: { totalEarningsCents: delta } },
        { returnDocument: "after", runValidators: true, session }
      );

      if (!updated) {
        const error = new Error("Wallet changed concurrently.");
        error.code = "WALLET_CONFLICT";
        throw error;
      }

      await WalletTransaction.create([{
        userId: user._id,
        type: "adjustment",
        amountCents,
        currency: "USD",
        status: "completed",
        createdByAdminId: req.user._id,
        idempotencyKey: key,
        adjustmentField: "totalEarnings",
        adjustmentDirection: direction,
        adjustmentReason: reason,
        adjustmentBeforeCents: before,
        adjustmentAfterCents: after,
        reference: "ADMIN-EARNINGS-" + new mongoose.Types.ObjectId().toString(),
        description: "Admin earnings " + direction + ": " + reason,
        completedAt: new Date()
      }], { session });

      await AdminAuditLog.create([{
        adminId: req.user._id,
        targetUserId: user._id,
        action: "earnings." + direction,
        reason,
        before: { totalEarnings: usd(before), currency: "USD" },
        after: {
          totalEarnings: usd(after),
          adjustmentAmount: amount,
          direction,
          currency: "USD"
        },
        ipAddress: req.ip
      }], { session });

      result = {
        userId: String(user._id),
        currency: "USD",
        previousEarnings: usd(before),
        adjustmentAmount: amount,
        direction,
        totalEarnings: usd(after),
        replayed: false
      };
    });

    return res.json({
      success: true,
      message: result.replayed
        ? "This earnings adjustment was already processed."
        : "Earnings adjustment recorded.",
      data: result
    });
  } catch (error) {
    if (error.code === "IDEMPOTENCY_CONFLICT") {
      return res.status(409).json({ success: false, message: error.message });
    }

    if (error.code === 11000 && key) {
      const existing = await WalletTransaction.findOne({
        createdByAdminId: req.user._id,
        idempotencyKey: key,
        type: "adjustment"
      }).lean().catch(() => null);

      if (existing && String(existing.userId) === String(req.params.id) &&
          existing.adjustmentField === "totalEarnings" &&
          existing.amountCents === amountCents &&
          existing.adjustmentDirection === direction &&
          existing.adjustmentReason === reason &&
          existing.currency === "USD" && existing.status === "completed") {
        return res.json({
          success: true,
          message: "This earnings adjustment was already processed.",
          data: {
            userId: String(existing.userId),
            currency: "USD",
            previousEarnings: usd(existing.adjustmentBeforeCents),
            adjustmentAmount: usd(existing.amountCents),
            direction,
            totalEarnings: usd(existing.adjustmentAfterCents),
            replayed: true
          }
        });
      }

      return res.status(409).json({
        success: false,
        message: "This Idempotency-Key conflicts with an existing adjustment."
      });
    }

    console.error("Admin earnings adjustment error:", error.message);

    if (["INVALID_EARNINGS", "WALLET_CURRENCY", "WALLET_INTEGRITY",
         "WALLET_CONFLICT"].includes(error.code)) {
      return res.status(409).json({ success: false, message: error.message });
    }

    if (error.code === 20 || error.codeName === "IllegalOperation" ||
        /transaction numbers are only allowed|transactions are not supported|replica set member or mongos/i.test(error.message || "")) {
      return res.status(503).json({
        success: false,
        message: "MongoDB transaction support is required. No adjustment was confirmed."
      });
    }

    return res.status(500).json({
      success: false,
      message: "Unable to confirm earnings adjustment. Check the ledger before retrying."
    });
  } finally {
    if (session) {
      try { await session.endSession(); }
      catch (error) { console.error("Session cleanup error:", error.message); }
    }
  }
});

/*
 * POST /api/admin/users/:id/membership-award
 * Body: { planId, reason }; requires Idempotency-Key.
 * This grants membership access, not a paid sale or referral commission.
 */
router.post("/:id/membership-award", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid user ID." });
  }

  const key = req.get("Idempotency-Key");
  const planId = req.body.planId;
  const reason = String(req.body.reason || "").trim();

  if (typeof key !== "string" || key.length < 8 || key.length > 100 ||
      !/^[A-Za-z0-9._:-]+$/.test(key)) {
    return res.status(400).json({
      success: false, message: "A valid Idempotency-Key header is required."
    });
  }
  if (!validId(planId)) {
    return res.status(400).json({ success: false, message: "Select a valid membership plan." });
  }
  if (reason.length < 5 || reason.length > 500) {
    return res.status(400).json({
      success: false, message: "Provide an award reason between 5 and 500 characters."
    });
  }

  let session;
  try {
    const user = await User.findById(req.params.id).select("_id username");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const plan = await MembershipPlan.findOne({
      _id: planId,
      active: true
    }).lean();

    if (!plan) {
      return res.status(404).json({
        success: false, message: "Active membership plan not found."
      });
    }

    session = await mongoose.startSession();
    let result;

    await session.withTransaction(async () => {
      const existing = await Membership.findOne({
        grantedByAdminId: req.user._id,
        grantIdempotencyKey: key,
        grantSource: "admin_award"
      }).session(session);

      if (existing) {
        const same = String(existing.userId) === String(user._id) &&
          String(existing.planId) === String(plan._id) &&
          existing.grantReason === reason;

        if (!same) {
          const error = new Error("Idempotency key already used for another award.");
          error.code = "IDEMPOTENCY_CONFLICT";
          throw error;
        }

        result = {
          membershipId: String(existing._id),
          userId: String(existing.userId),
          planKey: existing.planKey,
          startsAt: existing.startsAt,
          expiresAt: existing.expiresAt,
          grantSource: "admin_award",
          replayed: true
        };
        return;
      }

      const now = new Date();
      const current = await Membership.find({
        userId: user._id,
        status: "active",
        startsAt: { $lte: now },
        expiresAt: { $gt: now }
      }).session(session);

      let baseExpiry = now;
      for (const membership of current) {
        if (membership.expiresAt > baseExpiry) baseExpiry = membership.expiresAt;
      }

      // Mark replaced memberships as cancelled, retaining their historical records.
      if (current.length) {
        await Membership.updateMany(
          { _id: { $in: current.map(item => item._id) }, status: "active" },
          { $set: { status: "cancelled", cancelledAt: now } },
          { session }
        );
      }

      const startsAt = now;
      const expiresAt = new Date(
        baseExpiry.getTime() + Number(plan.durationDays) * 24 * 60 * 60 * 1000
      );

      const created = await Membership.create([{
        userId: user._id,
        planId: plan._id,
        planKey: plan.key,
        priceCents: plan.priceCents,
        currency: "USD",
        services: Array.isArray(plan.services) ? plan.services : [],
        status: "active",
        purchaseId: null,
        grantSource: "admin_award",
        grantReason: reason,
        grantedByAdminId: req.user._id,
        grantIdempotencyKey: key,
        startsAt,
        expiresAt,
        activatedAt: now
      }], { session });

      await AdminAuditLog.create([{
        adminId: req.user._id,
        targetUserId: user._id,
        action: "membership.admin_award",
        reason,
        before: {
          activeMembershipIds: current.map(item => String(item._id)),
          latestExpiry: baseExpiry
        },
        after: {
          membershipId: String(created[0]._id),
          planKey: plan.key,
          price: Number((plan.priceCents / 100).toFixed(2)),
          currency: "USD",
          startsAt,
          expiresAt,
          grantSource: "admin_award"
        },
        ipAddress: req.ip
      }], { session });

      result = {
        membershipId: String(created[0]._id),
        userId: String(user._id),
        planKey: plan.key,
        startsAt,
        expiresAt,
        grantSource: "admin_award",
        replayed: false
      };
    });

    return res.json({
      success: true,
      message: result.replayed
        ? "This membership award was already processed."
        : "Membership awarded and recorded. No payment or commission was created.",
      data: result
    });
  } catch (error) {
    if (error.code === "IDEMPOTENCY_CONFLICT") {
      return res.status(409).json({ success: false, message: error.message });
    }

    if (error.code === 11000 && key) {
      const existing = await Membership.findOne({
        grantedByAdminId: req.user._id,
        grantIdempotencyKey: key,
        grantSource: "admin_award"
      }).lean().catch(() => null);

      if (existing && String(existing.userId) === String(req.params.id) &&
          String(existing.planId) === String(planId) &&
          existing.grantReason === reason) {
        return res.json({
          success: true,
          message: "This membership award was already processed.",
          data: {
            membershipId: String(existing._id),
            userId: String(existing.userId),
            planKey: existing.planKey,
            startsAt: existing.startsAt,
            expiresAt: existing.expiresAt,
            grantSource: "admin_award",
            replayed: true
          }
        });
      }

      return res.status(409).json({
        success: false,
        message: "This Idempotency-Key conflicts with an existing membership award."
      });
    }

    console.error("Admin membership award error:", error.message);

    if (error.code === 20 || error.codeName === "IllegalOperation" ||
        /transaction numbers are only allowed|transactions are not supported|replica set member or mongos/i.test(error.message || "")) {
      return res.status(503).json({
        success: false,
        message: "MongoDB transaction support is required. No membership award was confirmed."
      });
    }

    return res.status(500).json({
      success: false,
      message: "Unable to confirm membership award. Check membership history before retrying."
    });
  } finally {
    if (session) {
      try { await session.endSession(); }
      catch (error) { console.error("Session cleanup error:", error.message); }
    }
  }
});


module.exports = router;
