"use strict";

const mongoose = require("mongoose");
const User = require("../models/User");
const Membership = require("../models/Membership");
const MembershipPurchase = require("../models/MembershipPurchase");
const Commission = require("../models/Commission");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function fulfilMembershipPurchase(purchaseId, options = {}) {
  const paymentMethod = options.paymentMethod || "daraja";
  if (!["daraja", "wallet"].includes(paymentMethod)) {
    throw codedError("INVALID_PAYMENT_METHOD");
  }
  if (!mongoose.isValidObjectId(purchaseId)) {
    throw codedError("PURCHASE_NOT_FOUND");
  }

  const session = await mongoose.startSession();
  let result;

  try {
    await session.withTransaction(async () => {
      const purchase = await MembershipPurchase.findById(purchaseId)
        .session(session);

      if (!purchase) throw codedError("PURCHASE_NOT_FOUND");
      if (paymentMethod === "wallet") {
        if (purchase.paymentMethod !== "wallet" || purchase.paymentStatus !== "pending") {
          throw codedError("PAYMENT_NOT_VERIFIED");
        }
      } else if (purchase.paymentStatus !== "verified") {
        throw codedError("PAYMENT_NOT_VERIFIED");
      }
      if (purchase.membershipId || purchase.activatedAt) {
        throw codedError("ALREADY_FULFILLED");
      }

      const amounts = purchase.commissionAmountsCentsSnapshot;
      const commissionsEnabled = purchase.commissionEnabledSnapshot;

      const totalSnapshotCommissionCents = Array.isArray(amounts)
        ? amounts.reduce(
            (sum, amount) => sum + (
              Number.isSafeInteger(amount) && amount >= 0 ? amount : 0
            ),
            0
          )
        : NaN;

      if (
        !Number.isSafeInteger(purchase.priceCents) ||
        purchase.priceCents < 1 ||
        purchase.currency !== "USD" ||
        typeof commissionsEnabled !== "boolean" ||
        !Array.isArray(amounts) ||
        amounts.length !== 4 ||
        !amounts.every(
          amount => Number.isSafeInteger(amount) && amount >= 0
        ) ||
        !Number.isSafeInteger(totalSnapshotCommissionCents) ||
        (
          commissionsEnabled &&
          totalSnapshotCommissionCents > purchase.priceCents
        ) ||
        !Number.isSafeInteger(purchase.durationDays) ||
        purchase.durationDays < 1
      ) {
        throw codedError("INVALID_PURCHASE_SNAPSHOT");
      }

      const purchaser = await User.findById(purchase.purchaserUserId)
        .select("_id referredBy")
        .session(session);

      if (!purchaser) throw codedError("PURCHASER_NOT_FOUND");


      const now = new Date();

      if (paymentMethod === "wallet") {
        const debit = await Wallet.findOneAndUpdate(
          {
            userId: purchaser._id,
            currency: "USD",
            availableBalanceCents: { $gte: purchase.priceCents }
          },
          { $inc: { availableBalanceCents: -purchase.priceCents } },
          { returnDocument: "after", session }
        );

        if (!debit) throw codedError("INSUFFICIENT_WALLET_BALANCE");

        await WalletTransaction.create(
          [{
            membershipPurchaseId: purchase._id,
            userId: purchaser._id,
            type: "membership_purchase",
            amountCents: purchase.priceCents,
            currency: "USD",
            status: "completed",
            reference: purchase.purchaseReference,
            description: `Membership purchase: ${purchase.planKey}`,
            completedAt: now
          }],
          { session }
        );
      }

      // Preserve any existing paid access, including a future-dated membership.
      const latestMembership = await Membership.findOne({
        userId: purchaser._id,
        status: "active",
        expiresAt: { $gt: now }
      })
        .sort({ expiresAt: -1, _id: -1 })
        .select("expiresAt")
        .session(session);

      const startsAt = latestMembership &&
        latestMembership.expiresAt > now
        ? new Date(latestMembership.expiresAt)
        : now;

      const expiresAt = new Date(
        startsAt.getTime() + purchase.durationDays * 86400000
      );

      if (!Number.isFinite(expiresAt.getTime())) {
        throw codedError("INVALID_PURCHASE_SNAPSHOT");
      }

      const membership = new Membership({
        userId: purchaser._id,
        planId: purchase.planId,
        planKey: purchase.planKey,
        priceCents: purchase.priceCents,
        currency: "USD",
        services: purchase.services,
        status: "active",
        purchaseId: purchase._id,
        startsAt,
        expiresAt,
        activatedAt: now
      });

      await membership.save({ session });

      let commissionsCreated = 0;
      let totalCommissionCents = 0;

      const visited = new Set([String(purchaser._id)]);
      let sponsorId = purchaser.referredBy;

      for (let level = 1; level <= 4 && sponsorId; level += 1) {
        const sponsorIdString = String(sponsorId);

        // Stop malformed referral cycles instead of paying the same person twice.
        if (visited.has(sponsorIdString)) break;
        visited.add(sponsorIdString);

        const sponsor = await User.findById(sponsorId)
          .select("_id referredBy")
          .session(session);

        if (!sponsor) break;

        const amountCents = amounts[level - 1];

        if (
          commissionsEnabled &&
          Number.isSafeInteger(amountCents) &&
          amountCents > 0
        ) {
          const [commission] = await Commission.create(
            [{
              membershipId: membership._id,
              beneficiaryUserId: sponsor._id,
              purchaserUserId: purchaser._id,
              level,
              amountCents,
              currency: "USD",
              status: "paid",
              paidAt: now
            }],
            { session }
          );

          await Wallet.findOneAndUpdate(
            { userId: sponsor._id },
            {
              $setOnInsert: {
                userId: sponsor._id,
                currency: "USD"
              },
              $inc: {
                availableBalanceCents: amountCents,
                totalEarningsCents: amountCents
              }
            },
            {
              upsert: true,
              returnDocument: "after",
              session,
              setDefaultsOnInsert: true
            }
          );

          const [walletTransaction] = await WalletTransaction.create(
            [{
              commissionId: commission._id,
              userId: sponsor._id,
              type: "commission",
              amountCents,
              currency: "USD",
              status: "completed",
              reference: purchase.purchaseReference,
              description:
                `Level ${level} referral commission for membership purchase ${purchase.purchaseReference}`,
              relatedUserId: purchaser._id,
              completedAt: now
            }],
            { session }
          );

          await Commission.updateOne(
            { _id: commission._id },
            { $set: { walletTransactionId: walletTransaction._id } },
            { session }
          );

          commissionsCreated += 1;
          totalCommissionCents += amountCents;
        }

        sponsorId = sponsor.referredBy;
      }

      const purchaseGuard = {
        _id: purchase._id,
        paymentStatus: paymentMethod === "wallet" ? "pending" : "verified",
        membershipId: null,
        activatedAt: null
      };

      if (paymentMethod === "wallet") {
        purchaseGuard.paymentMethod = "wallet";
      }

      const purchaseSet = {
        membershipId: membership._id,
        activatedAt: now
      };

      if (paymentMethod === "wallet") {
        purchaseSet.paymentStatus = "verified";
      }

      const updatedPurchase = await MembershipPurchase.updateOne(
        purchaseGuard,
        { $set: purchaseSet },
        { session }
      );

      if (updatedPurchase.modifiedCount !== 1) {
        throw codedError("PURCHASE_CHANGED");
      }

      result = {
        purchaseId: String(purchase._id),
        membershipId: String(membership._id),
        startsAt,
        expiresAt,
        commissionsCreated,
        totalCommissionCents
      };
    });

    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { fulfilMembershipPurchase };
