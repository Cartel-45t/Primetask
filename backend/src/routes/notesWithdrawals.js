"use strict";

const express = require("express");
const mongoose = require("mongoose");
const { randomUUID } = require("crypto");

const NotesWithdrawal = require("../models/NotesWithdrawal");
const NotesWallet = require("../models/NotesWallet");
const NotesTransaction = require("../models/NotesTransaction");
const PlatformSetting = require("../models/PlatformSetting");
const requireAuth = require("../middleware/requireAuth");
const { initiateB2CPayment } = require("../services/darajaB2CService");

const router = express.Router();
router.use(requireAuth);

const MIN_CENTS = Number(process.env.WALLET_WITHDRAWAL_MIN_USD_CENTS || 785);
const MAX_CENTS = Number(process.env.WALLET_WITHDRAWAL_MAX_USD_CENTS || 50000);

function isAdmin(req) {
  return ["admin", "founder"].includes(req.user.role);
}
function usd(cents) {
  return Number((cents / 100).toFixed(2));
}
function amountCents(value) {
  const s = String(value ?? "").trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, fraction = ""] = s.split(".");
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(n) ? n : null;
}
function phone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return "254" + digits.slice(1);
  if (/^[17]\d{8}$/.test(digits)) return "254" + digits;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return null;
}
function validLimits() {
  return Number.isSafeInteger(MIN_CENTS) &&
    Number.isSafeInteger(MAX_CENTS) && MIN_CENTS > 0 && MAX_CENTS >= MIN_CENTS;
}
function fail(res, status, message) {
  return res.status(status).json({ success: false, message });
}
function publicRecord(w) {
  return {
    requestId: w.requestId,
    amount: usd(w.amountCents),
    currency: "USD",
    exchangeRateKesPerUsd: w.exchangeRateKesPerUsd,
    payoutAmountKes: w.payoutAmountKes,
    phoneNumber: w.phoneNumber,
    status: w.status,
    b2cInitiationState: w.b2cInitiationState,
    mpesaReceipt: w.mpesaReceipt,
    adminNote: w.adminNote,
    createdAt: w.createdAt,
    reviewedAt: w.reviewedAt,
    updatedAt: w.updatedAt
  };
}
async function readRate() {
  const settings = await PlatformSetting.findOne({ key: "platform" }).lean();
  const rate = settings?.exchangeRateKesPerUsd;
  return typeof rate === "number" && Number.isFinite(rate) && rate >= 1 && rate <= 1000
    ? rate : null;
}

router.get("/quote", async (req, res) => {
  try {
    if (!validLimits()) return fail(res, 500, "Withdrawal limits are misconfigured.");
    const cents = amountCents(req.query.amount);
    const rate = await readRate();
    if (rate === null) return fail(res, 503, "The administrator has not configured a valid payout rate.");
    const valid = cents !== null && cents >= MIN_CENTS && cents <= MAX_CENTS;
    return res.json({
      success: true,
      currency: "USD",
      minimumAmount: usd(MIN_CENTS),
      maximumAmount: usd(MAX_CENTS),
      exchangeRateKesPerUsd: rate,
      amount: cents === null ? null : usd(cents),
      payoutAmountKes: valid ? Math.round(cents * rate / 100) : null
    });
  } catch (error) {
    console.error("Notes withdrawal quote failed:", error.message);
    return fail(res, 500, "Could not load the Notes withdrawal quote.");
  }
});

router.post("/", async (req, res) => {
  const cents = amountCents(req.body?.amount);
  const phoneNumber = phone(req.body?.phoneNumber);

  if (!validLimits()) return fail(res, 500, "Withdrawal limits are misconfigured.");
  if (cents === null || cents < MIN_CENTS || cents > MAX_CENTS) {
    return fail(res, 400, `Enter an amount between $${usd(MIN_CENTS).toFixed(2)} and $${usd(MAX_CENTS).toFixed(2)} USD.`);
  }
  if (!phoneNumber) return fail(res, 400, "Enter a valid Kenyan M-Pesa phone number.");

  let session;
  try {
    const rate = await readRate();
    if (rate === null) return fail(res, 503, "Withdrawals need a valid administrator-configured payout rate.");
    const payoutAmountKes = Math.round(cents * rate / 100);
    if (!Number.isSafeInteger(payoutAmountKes) || payoutAmountKes < 1) {
      return fail(res, 400, "The calculated M-Pesa payout is invalid.");
    }

    const requestId = `PTW-NOTES-WD-${randomUUID()}`;
    session = await mongoose.startSession();
    let created;

    await session.withTransaction(async () => {
      const wallet = await NotesWallet.findOneAndUpdate(
        { userId: req.user._id, availableBalanceCents: { $gte: cents } },
        { $inc: { availableBalanceCents: -cents, reservedBalanceCents: cents } },
        { new: true, session, runValidators: true }
      );
      if (!wallet) {
        const error = new Error("INSUFFICIENT_NOTES_EARNINGS");
        error.code = "INSUFFICIENT_NOTES_EARNINGS";
        throw error;
      }

      const [withdrawal] = await NotesWithdrawal.create([{
        requestId,
        userId: req.user._id,
        amountCents: cents,
        currency: "USD",
        exchangeRateKesPerUsd: rate,
        payoutAmountKes,
        phoneNumber
      }], { session });

      await NotesTransaction.create([{
        userId: req.user._id,
        walletId: wallet._id,
        type: "withdrawal",
        amountCents: -cents,
        reference: requestId,
        description: "Notes earnings reserved for withdrawal",
        metadata: { payoutAmountKes, exchangeRateKesPerUsd: rate }
      }], { session });

      created = publicRecord(withdrawal);
    });

    return res.status(201).json({ success: true, withdrawal: created });
  } catch (error) {
    if (error.code === "INSUFFICIENT_NOTES_EARNINGS") {
      return fail(res, 402, "Your available Notes earnings balance is insufficient.");
    }
    console.error("Notes withdrawal request failed:", error.message);
    return fail(res, 500, "Could not create the Notes withdrawal request.");
  } finally {
    if (session) await session.endSession();
  }
});

router.get("/mine", async (req, res) => {
  try {
    const items = await NotesWithdrawal.find({ userId: req.user._id })
      .sort({ createdAt: -1 }).limit(50).lean();
    return res.json({ success: true, withdrawals: items.map(publicRecord) });
  } catch (error) {
    console.error("Notes withdrawal history failed:", error.message);
    return fail(res, 500, "Could not load Notes withdrawal history.");
  }
});

router.get("/admin", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Administrator access required.");
  try {
    const items = await NotesWithdrawal.find({})
      .sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ success: true, withdrawals: items.map(publicRecord) });
  } catch (error) {
    console.error("Notes withdrawal admin list failed:", error.message);
    return fail(res, 500, "Could not load Notes withdrawal requests.");
  }
});

router.post("/:requestId/approve", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Administrator access required.");
  try {
    const item = await NotesWithdrawal.findOneAndUpdate(
      { requestId: req.params.requestId, status: "pending_review" },
      { $set: { status: "approved", reviewedBy: req.user._id, reviewedAt: new Date(), adminNote: String(req.body?.note || "").slice(0, 300) } },
      { new: true, runValidators: true }
    );
    if (!item) return fail(res, 409, "Request not found or is no longer awaiting review.");
    return res.json({ success: true, withdrawal: publicRecord(item) });
  } catch (error) {
    console.error("Notes withdrawal approval failed:", error.message);
    return fail(res, 500, "Could not approve this Notes withdrawal.");
  }
});

router.post("/:requestId/reject", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Administrator access required.");
  const session = await mongoose.startSession();
  try {
    let rejected = null;
    await session.withTransaction(async () => {
      const item = await NotesWithdrawal.findOne({
        requestId: req.params.requestId,
        status: { $in: ["pending_review", "approved"] }
      }).session(session);
      if (!item) {
        const error = new Error("WITHDRAWAL_NOT_REJECTABLE");
        error.code = "WITHDRAWAL_NOT_REJECTABLE";
        throw error;
      }

      const wallet = await NotesWallet.findOneAndUpdate(
        { userId: item.userId, reservedBalanceCents: { $gte: item.amountCents } },
        { $inc: { reservedBalanceCents: -item.amountCents, availableBalanceCents: item.amountCents } },
        { new: true, session, runValidators: true }
      );
      if (!wallet) throw new Error("Notes reserved balance is inconsistent.");

      await NotesTransaction.create([{
        userId: item.userId,
        walletId: wallet._id,
        type: "withdrawal_reversal",
        amountCents: item.amountCents,
        reference: `${item.requestId}-REVERSAL`,
        description: "Rejected Notes withdrawal returned to available earnings"
      }], { session });

      item.status = "rejected";
      item.reviewedBy = req.user._id;
      item.reviewedAt = new Date();
      item.adminNote = String(req.body?.note || "").slice(0, 300);
      await item.save({ session });
      rejected = publicRecord(item);
    });
    return res.json({ success: true, withdrawal: rejected });
  } catch (error) {
    if (error.code === "WITHDRAWAL_NOT_REJECTABLE") return fail(res, 409, "Only pending or approved requests can be rejected.");
    console.error("Notes withdrawal rejection failed:", error.message);
    return fail(res, 500, "Could not reject this Notes withdrawal.");
  } finally {
    await session.endSession();
  }
});

router.post("/:requestId/initiate-b2c", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Administrator access required.");
  const originatorConversationId = `PTWNOTESB2C_${randomUUID()}`;
  let item;

  try {
    item = await NotesWithdrawal.findOneAndUpdate(
      { requestId: req.params.requestId, status: "approved", b2cInitiationState: "not_started" },
      {
        $set: {
          status: "processing",
          b2cInitiationState: "submitting",
          b2cOriginatorConversationId: originatorConversationId,
          b2cInitiatedAt: new Date()
        }
      },
      { new: true, runValidators: true }
    );
    if (!item) return fail(res, 409, "Request is not approved or payout initiation has already started.");

    const result = await initiateB2CPayment({
      originatorConversationId,
      phoneNumber: item.phoneNumber,
      amountKes: item.payoutAmountKes,
      remarks: "PrimeTask Notes withdrawal",
      occasion: item.requestId
    });

    const state = result?.accepted ? "accepted"
      : result?.definitiveRejection ? "rejected" : "unknown";

    item.b2cInitiationState = state;
    item.b2cConversationId = result?.conversationId || null;
    item.b2cResultDescription = String(result?.responseDescription || "").slice(0, 500);
    if (state === "rejected") item.status = "approved";
    if (state === "unknown") item.status = "reconciliation_required";
    await item.save();

    return res.json({
      success: state === "accepted",
      message: state === "accepted"
        ? "Daraja accepted the Notes payout request. Awaiting provider callback."
        : state === "rejected"
          ? "Daraja rejected the initiation. The request remains approved for review."
          : "Payout outcome is uncertain. Reconciliation is required before retrying.",
      withdrawal: publicRecord(item)
    });
  } catch (error) {
    console.error("Notes B2C initiation failed:", error.message);
    if (item) {
      await NotesWithdrawal.updateOne(
        { _id: item._id, b2cInitiationState: "submitting" },
        { $set: { status: "reconciliation_required", b2cInitiationState: "unknown", b2cResultDescription: "Initiation outcome uncertain; reconcile before retrying." } }
      ).catch(() => {});
    }
    return fail(res, 500, "Payout initiation failed or has an uncertain outcome. Check reconciliation before retrying.");
  }
});

module.exports = router;
