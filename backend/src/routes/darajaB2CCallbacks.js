"use strict";

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");

const Withdrawal = require("../models/Withdrawal");
const DarajaB2CCallbackEvent = require("../models/DarajaB2CCallbackEvent");
const MpesaReceiptClaim = require("../models/MpesaReceiptClaim");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");

const router = express.Router();

function tokenIsValid(supplied) {
  const expected = String(process.env.DARAJA_B2C_CALLBACK_TOKEN || "");
  if (expected.length < 32 || typeof supplied !== "string") return false;

  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getResult(req) {
  const result = req.body?.Result;
  return result && typeof result === "object" ? result : null;
}

function resultParameters(result) {
  const list = result?.ResultParameters?.ResultParameter;
  const values = {};

  if (!Array.isArray(list)) return values;

  for (const item of list) {
    if (item && typeof item.Key === "string") {
      values[item.Key] = item.Value;
    }
  }

  return values;
}

function safeText(value, max = 500) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function numericValue(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function callbackHash(type, result) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ type, result }))
    .digest("hex");
}

async function saveEvent(eventKey, callbackType, fields) {
  try {
    return await DarajaB2CCallbackEvent.create({
      eventKey,
      callbackType,
      ...fields
    });
  } catch (error) {
    if (error.code === 11000) {
      return DarajaB2CCallbackEvent.findOne({ eventKey });
    }
    throw error;
  }
}

async function markReconciliation(event, originatorId, reason) {
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      if (originatorId) {
        await Withdrawal.updateOne(
          {
            b2cOriginatorConversationId: originatorId,
            status: { $in: ["processing", "reconciliation_required"] }
          },
          {
            $set: {
              status: "reconciliation_required",
              b2cInitiationState: "unknown",
              b2cResultDescription: safeText(reason, 500)
            }
          },
          { session, runValidators: true }
        );
      }

      await DarajaB2CCallbackEvent.updateOne(
        { _id: event._id },
        { $set: { processingStatus: "reconciliation_required" } },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }
}

async function handleCallback(req, res, callbackType) {
  if (!tokenIsValid(req.query.token)) {
    return res.status(401).json({ success: false });
  }

  const result = getResult(req);

  if (!result) {
    return res.status(400).json({ success: false });
  }

  const originatorId = safeText(result.OriginatorConversationID, 100).trim();

  if (!originatorId) {
    // No safe way to correlate this callback to a withdrawal.
    return res.status(400).json({ success: false });
  }

  const params = resultParameters(result);
  const code = numericValue(result.ResultCode);
  const amount = numericValue(params.TransactionAmount);
  const receipt = typeof params.TransactionReceipt === "string"
    ? params.TransactionReceipt.trim().toUpperCase()
    : "";

  const eventKey = callbackHash(callbackType, result);
  let event;

  try {
    event = await saveEvent(eventKey, callbackType, {
      originatorConversationId: originatorId,
      conversationId: safeText(result.ConversationID, 150) || null,
      resultCode: code,
      resultDescription: safeText(result.ResultDesc),
      transactionId: receipt || null,
      transactionAmountKes: amount && amount > 0 ? amount : null,
      receiverPartyPublicName:
        safeText(params.ReceiverPartyPublicName, 200) || null,
      transactionCompletedDateTime:
        safeText(params.TransactionCompletedDateTime, 30) || null
    });
  } catch {
    // Safaricom should retry if durable receipt of the callback failed.
    return res.status(500).json({ success: false });
  }

  if (!event) {
    return res.status(500).json({ success: false });
  }

  if (event.processingStatus === "processed") {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Already processed" });
  }

  if (callbackType === "timeout" || code !== 0) {
    try {
      await markReconciliation(
        event,
        originatorId,
        callbackType === "timeout"
          ? "Daraja B2C timeout callback received; payout outcome requires reconciliation."
          : safeText(result.ResultDesc) || "Daraja reported an unsuccessful B2C result."
      );
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Received for reconciliation" });
    } catch {
      return res.status(500).json({ success: false });
    }
  }

  if (
    !receipt ||
    !/^[A-Z0-9]{6,30}$/.test(receipt) ||
    !Number.isSafeInteger(amount) ||
    amount < 1
  ) {
    try {
      await markReconciliation(
        event,
        originatorId,
        "Successful B2C callback is missing a valid receipt or whole-KSh amount."
      );
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Received for reconciliation" });
    } catch {
      return res.status(500).json({ success: false });
    }
  }

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const withdrawal = await Withdrawal.findOne({
        b2cOriginatorConversationId: originatorId
      }).session(session);

      if (!withdrawal) {
        const error = new Error("WITHDRAWAL_NOT_FOUND");
        error.code = "WITHDRAWAL_NOT_FOUND";
        throw error;
      }

      // A duplicate callback may arrive after a completed payment.
      if (
        withdrawal.status === "paid" &&
        withdrawal.mpesaReceipt === receipt
      ) {
        await DarajaB2CCallbackEvent.updateOne(
          { _id: event._id },
          { $set: { processingStatus: "processed" } },
          { session }
        );
        return;
      }

      if (
        !["processing", "reconciliation_required"].includes(withdrawal.status) ||
        !["submitting", "accepted", "unknown"].includes(withdrawal.b2cInitiationState) ||
        withdrawal.payoutAmountKes !== amount ||
        !withdrawal.transactionId
      ) {
        const error = new Error("CALLBACK_WITHDRAWAL_MISMATCH");
        error.code = "CALLBACK_WITHDRAWAL_MISMATCH";
        throw error;
      }

      await MpesaReceiptClaim.create([{
        receipt,
        purpose: "withdrawal",
        referenceId: withdrawal.requestId,
        amountKes: amount,
        evidenceSource: "daraja_provider_confirmation",
        evidenceReference: originatorId
      }], { session });

      const walletResult = await Wallet.updateOne(
        { userId: withdrawal.userId, currency: "USD" },
        { $inc: { totalWithdrawalsCents: withdrawal.amountCents } },
        { session, runValidators: true }
      );

      if (walletResult.matchedCount !== 1) {
        throw new Error("Wallet missing during B2C completion.");
      }

      const ledgerResult = await WalletTransaction.updateOne(
        {
          _id: withdrawal.transactionId,
          userId: withdrawal.userId,
          type: "withdrawal",
          status: "pending",
          amountCents: withdrawal.amountCents
        },
        {
          $set: {
            status: "completed",
            completedAt: new Date(),
            description: `Daraja B2C payout confirmed. Receipt: ${receipt}`
          }
        },
        { session, runValidators: true }
      );

      if (ledgerResult.modifiedCount !== 1) {
        throw new Error("Withdrawal ledger is missing or already processed.");
      }

      const update = await Withdrawal.updateOne(
        {
          _id: withdrawal._id,
          status: { $in: ["processing", "reconciliation_required"] },
          b2cOriginatorConversationId: originatorId
        },
        {
          $set: {
            status: "paid",
            b2cInitiationState: "succeeded",
            b2cConversationId: safeText(result.ConversationID, 150) || null,
            b2cResultCode: code,
            b2cResultDescription: safeText(result.ResultDesc),
            mpesaReceipt: receipt
          }
        },
        { session, runValidators: true }
      );

      if (update.modifiedCount !== 1) {
        throw new Error("Withdrawal state changed during callback processing.");
      }

      await DarajaB2CCallbackEvent.updateOne(
        { _id: event._id },
        { $set: { processingStatus: "processed" } },
        { session }
      );
    });

    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (error) {
    try {
      await markReconciliation(
        event,
        originatorId,
        error.code === "CALLBACK_WITHDRAWAL_MISMATCH"
          ? "B2C callback did not match the expected withdrawal, amount, or state."
          : error.code === "WITHDRAWAL_NOT_FOUND"
            ? "B2C callback references an unknown withdrawal."
            : "B2C callback processing failed; manual reconciliation is required."
      );

      // The event is durably stored and marked for reconciliation.
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Received for reconciliation" });
    } catch {
      return res.status(500).json({ success: false });
    }
  } finally {
    await session.endSession();
  }
}

router.post("/result", (req, res) => handleCallback(req, res, "result"));
router.post("/timeout", (req, res) => handleCallback(req, res, "timeout"));

module.exports = router;
