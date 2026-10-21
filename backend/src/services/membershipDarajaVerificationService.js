"use strict";

const mongoose = require("mongoose");
const MembershipPurchase = require("../models/MembershipPurchase");
const MpesaReceiptClaim = require("../models/MpesaReceiptClaim");
const MembershipPaymentReconciliation = require("../models/MembershipPaymentReconciliation");
const Deposit = require("../models/Deposit");
const Withdrawal = require("../models/Withdrawal");
const { queryStkPush } = require("./darajaService");
const { fulfilMembershipPurchase } = require("./membershipFulfilmentService");

function normalizeReceipt(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

async function verifyAndFulfilMembershipCallback({
  purchaseId,
  checkoutRequestId,
  merchantRequestId,
  resultCode,
  metadata
}) {
  if (resultCode !== 0) {
    return { verified: false, reason: "PAYMENT_NOT_SUCCESSFUL" };
  }

  const receipt = normalizeReceipt(metadata?.receipt);
  const amountKes = metadata?.amountKes;
  const phoneNumber = metadata?.phoneNumber;

  if (
    !/^[A-Z0-9]{6,30}$/.test(receipt) ||
    !Number.isSafeInteger(amountKes) ||
    amountKes < 1 ||
    !/^\d{12}$/.test(String(phoneNumber || ""))
  ) {
    return { verified: false, reason: "CALLBACK_METADATA_INCOMPLETE" };
  }

  const purchase = await MembershipPurchase.findById(purchaseId).lean();

  if (!purchase || purchase.checkoutRequestId !== checkoutRequestId) {
    return { verified: false, reason: "CHECKOUT_MISMATCH" };
  }

  if (
    purchase.merchantRequestId &&
    merchantRequestId !== purchase.merchantRequestId
  ) {
    return { verified: false, reason: "MERCHANT_REQUEST_MISMATCH" };
  }

  if (
    purchase.paymentMethod !== "daraja" ||
    !Number.isSafeInteger(purchase.expectedAmountKes) ||
    amountKes !== purchase.expectedAmountKes ||
    String(phoneNumber) !== String(purchase.phoneNumber)
  ) {
    return { verified: false, reason: "PAYMENT_DETAILS_MISMATCH" };
  }

  let providerResult;

  try {
    providerResult = await queryStkPush({ checkoutRequestId });
  } catch {
    return { verified: false, reason: "PROVIDER_QUERY_FAILED" };
  }

  if (
    providerResult?.mode !== "live" ||
    String(providerResult?.responseCode) !== "0" ||
    String(providerResult?.resultCode) !== "0" ||
    providerResult?.checkoutRequestId !== checkoutRequestId
  ) {
    return { verified: false, reason: "PROVIDER_CONFIRMATION_INCOMPLETE" };
  }

  const session = await mongoose.startSession();
  let verified = false;

  try {
    await session.withTransaction(async () => {
      const current = await MembershipPurchase.findById(purchaseId)
        .session(session);

      if (!current || current.checkoutRequestId !== checkoutRequestId) {
        throw new Error("CHECKOUT_MISMATCH");
      }

      if (current.paymentStatus === "verified") {
        if (normalizeReceipt(current.mpesaReceipt) !== receipt) {
          throw new Error("VERIFIED_RECEIPT_MISMATCH");
        }
        verified = true;
        return;
      }

      if (!["pending", "verification_required"].includes(current.paymentStatus)) {
        throw new Error("PURCHASE_NOT_ELIGIBLE");
      }

      if (
        current.expectedAmountKes !== amountKes ||
        String(current.phoneNumber) !== String(phoneNumber) ||
        (current.merchantRequestId &&
          current.merchantRequestId !== merchantRequestId)
      ) {
        throw new Error("PAYMENT_DETAILS_MISMATCH");
      }

      const [
        existingPurchase,
        existingDeposit,
        existingWithdrawal,
        existingReconciliation
      ] = await Promise.all([
        MembershipPurchase.findOne({
          _id: { $ne: current._id },
          mpesaReceipt: receipt
        }).session(session).lean(),

        Deposit.findOne({
          mpesaReceipt: receipt,
          status: "completed"
        }).session(session).lean(),

        Withdrawal.findOne({
          mpesaReceipt: receipt,
          status: "paid"
        }).session(session).lean(),

        MembershipPaymentReconciliation.findOne({
          mpesaReceipt: receipt
        }).session(session).lean()
      ]);

      if (
        existingPurchase ||
        existingDeposit ||
        existingWithdrawal ||
        existingReconciliation
      ) {
        throw new Error("RECEIPT_ALREADY_USED");
      }

      await MpesaReceiptClaim.create([{
        receipt,
        purpose: "membership_purchase",
        referenceId: String(current._id),
        amountKes,
        evidenceSource: "daraja_provider_confirmation",
        evidenceReference: checkoutRequestId
      }], { session });

      const now = new Date();

      const update = await MembershipPurchase.updateOne(
        {
          _id: current._id,
          paymentStatus: { $in: ["pending", "verification_required"] },
          checkoutRequestId,
          expectedAmountKes: amountKes,
          phoneNumber
        },
        {
          $set: {
            paymentStatus: "verified",
            mpesaReceipt: receipt,
            verifiedAmountKes: amountKes,
            verificationMethod: "provider_confirmation",
            verifiedAt: now,
            verificationReference: checkoutRequestId,
            lastReconciledAt: now,
            failureCode: null,
            failureDescription: ""
          }
        },
        { session }
      );

      if (update.modifiedCount !== 1) {
        throw new Error("PURCHASE_VERIFICATION_RACE");
      }

      verified = true;
    });
  } finally {
    await session.endSession();
  }

  if (!verified) {
    return { verified: false, reason: "VERIFICATION_NOT_COMPLETED" };
  }

  try {
    const latest = await MembershipPurchase.findById(purchaseId).lean();

    if (latest?.membershipId || latest?.activatedAt) {
      return { verified: true, fulfilled: true, alreadyFulfilled: true };
    }

    await fulfilMembershipPurchase(purchaseId, { paymentMethod: "daraja" });

    return { verified: true, fulfilled: true };
  } catch (error) {
    // Payment remains verified. Existing admin fulfilment is the safe
    // recovery path if activation fails after successful payment verification.
    console.error(
      "Verified membership fulfilment requires recovery:",
      String(purchaseId),
      error.message
    );

    return { verified: true, fulfilled: false, reason: error.code || "FULFILMENT_FAILED" };
  }
}

module.exports = { verifyAndFulfilMembershipCallback };
