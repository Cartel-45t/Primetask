"use strict";

const mongoose = require("mongoose");
const MinutePurchase = require("../models/TranscriptionMinutePurchase");
const MinuteWallet = require("../models/TranscriptionMinuteWallet");
const MinuteTransaction = require("../models/TranscriptionMinuteTransaction");
const MpesaReceiptClaim = require("../models/MpesaReceiptClaim");
const {
  queryStkPush
} = require("./transcriptionDarajaService");

function normalizeReceipt(value) {
  return typeof value === "string"
    ? value.trim().toUpperCase()
    : "";
}

async function verifyAndCreditTranscriptionMinutePurchase({
  purchaseId,
  checkoutRequestId,
  merchantRequestId,
  resultCode,
  metadata,
  queryProvider = queryStkPush
}) {
  if (resultCode !== 0) {
    return { verified: false, reason: "PAYMENT_NOT_SUCCESSFUL" };
  }

  const receipt = normalizeReceipt(metadata?.receipt);
  const amountKes = metadata?.amountKes;
  const phoneNumber = String(metadata?.phoneNumber || "");

  if (
    !/^[A-Z0-9]{6,30}$/.test(receipt) ||
    !Number.isSafeInteger(amountKes) ||
    amountKes < 1 ||
    !/^254[17]\d{8}$/.test(phoneNumber)
  ) {
    return { verified: false, reason: "CALLBACK_METADATA_INCOMPLETE" };
  }

  const purchase = await MinutePurchase.findById(purchaseId).lean();

  if (
    !purchase ||
    purchase.checkoutRequestId !== checkoutRequestId
  ) {
    return { verified: false, reason: "CHECKOUT_MISMATCH" };
  }

  if (
    !purchase.merchantRequestId ||
    !merchantRequestId ||
    purchase.merchantRequestId !== merchantRequestId
  ) {
    return { verified: false, reason: "MERCHANT_REQUEST_MISMATCH" };
  }

  if (
    purchase.expectedAmountKes !== amountKes ||
    String(purchase.phoneNumber) !== phoneNumber
  ) {
    return { verified: false, reason: "PAYMENT_DETAILS_MISMATCH" };
  }

  let providerResult;

  try {
    providerResult = await queryProvider({ checkoutRequestId });
  } catch (error) {
    return {
      verified: false,
      reason: "PROVIDER_QUERY_FAILED",
      detail: String(error?.message || "").slice(0, 250)
    };
  }

  if (
    providerResult?.mode !== "live" ||
    String(providerResult?.responseCode) !== "0" ||
    String(providerResult?.resultCode) !== "0" ||
    providerResult?.checkoutRequestId !== checkoutRequestId
  ) {
    return {
      verified: false,
      reason: providerResult?.mode === "disabled"
        ? "PROVIDER_QUERY_DISABLED"
        : "PROVIDER_CONFIRMATION_INCOMPLETE"
    };
  }

  const session = await mongoose.startSession();
  let alreadyVerified = false;

  try {
    await session.withTransaction(async () => {
      const current = await MinutePurchase.findById(purchaseId)
        .session(session);

      if (!current || current.checkoutRequestId !== checkoutRequestId) {
        throw new Error("CHECKOUT_MISMATCH");
      }

      if (current.paymentStatus === "verified") {
        if (normalizeReceipt(current.mpesaReceipt) !== receipt) {
          throw new Error("VERIFIED_RECEIPT_MISMATCH");
        }

        alreadyVerified = true;
        return;
      }

      if (
        !["pending", "verification_required"].includes(
          current.paymentStatus
        )
      ) {
        throw new Error("PURCHASE_NOT_ELIGIBLE");
      }

      if (
        current.expectedAmountKes !== amountKes ||
        String(current.phoneNumber) !== phoneNumber ||
        current.merchantRequestId !== merchantRequestId
      ) {
        throw new Error("PAYMENT_DETAILS_MISMATCH");
      }

      // The unique global receipt index prevents one receipt from being
      // used for deposits, memberships, withdrawals, or another purchase.
      await MpesaReceiptClaim.create([{
        receipt,
        purpose: "transcription_minute_purchase",
        referenceId: String(current._id),
        amountKes,
        evidenceSource: "daraja_provider_confirmation",
        evidenceReference: checkoutRequestId
      }], { session });

      const wallet = await MinuteWallet.findOneAndUpdate(
        { userId: current.userId },
        {
          $setOnInsert: { userId: current.userId },
          $inc: {
            availableMinutes: current.minutes,
            totalPurchasedMinutes: current.minutes
          }
        },
        {
          session,
          returnDocument: "after",
          upsert: true,
          setDefaultsOnInsert: true,
          runValidators: true
        }
      );

      if (!wallet) {
        throw new Error("MINUTE_WALLET_CREDIT_FAILED");
      }

      await MinuteTransaction.create([{
        userId: current.userId,
        walletId: wallet._id,
        type: "purchase_credit",
        minutes: current.minutes,
        reference: `TRANSCRIPTION-MINUTE-PURCHASE-${current._id}`,
        purchaseId: current._id,
        description: `Minute package: ${current.packageName}`
      }], { session });

      current.paymentStatus = "verified";
      current.hasUnresolvedPayment = false;
      current.mpesaReceipt = receipt;
      current.verifiedAmountKes = amountKes;
      current.verificationMethod = "provider_confirmation";
      current.evidenceSource = "daraja_provider_confirmation";
      current.evidenceReference = checkoutRequestId;
      current.verifiedAt = new Date();
      current.lastReconciledAt = new Date();
      current.failureCode = null;
      current.failureDescription = "";

      await current.save({ session });
    });
  } catch (error) {
    if (error?.code === 11000) {
      return {
        verified: false,
        reason: "RECEIPT_ALREADY_USED"
      };
    }

    return {
      verified: false,
      reason: error?.message || "TRANSACTION_FAILED"
    };
  } finally {
    await session.endSession();
  }

  return {
    verified: true,
    alreadyVerified,
    receipt
  };
}

module.exports = {
  verifyAndCreditTranscriptionMinutePurchase
};
