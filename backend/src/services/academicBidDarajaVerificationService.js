"use strict";

const mongoose = require("mongoose");
const Purchase = require("../models/AcademicBidPurchase");
const Wallet = require("../models/AcademicBidWallet");
const Transaction = require("../models/AcademicBidTransaction");
const MpesaReceiptClaim = require("../models/MpesaReceiptClaim");
const { queryStkPush } = require("./darajaService");

async function verifyAndCreditAcademicBidPurchase({ purchaseId, checkoutRequestId, merchantRequestId, resultCode, metadata, queryProvider = queryStkPush }) {
  const receipt = typeof metadata?.receipt === "string" ? metadata.receipt.trim().toUpperCase() : "";
  const amountKes = metadata?.amountKes;
  const phoneNumber = String(metadata?.phoneNumber || "");
  if (resultCode !== 0 || !/^[A-Z0-9]{6,30}$/.test(receipt) || !Number.isSafeInteger(amountKes) || amountKes < 1 || !/^254[17]\d{8}$/.test(phoneNumber)) return { verified: false, reason: "CALLBACK_METADATA_INCOMPLETE" };
  const purchase = await Purchase.findById(purchaseId).lean();
  if (!purchase || purchase.checkoutRequestId !== checkoutRequestId || purchase.merchantRequestId !== merchantRequestId || purchase.expectedAmountKes !== amountKes || purchase.phoneNumber !== phoneNumber) return { verified: false, reason: "PURCHASE_MISMATCH" };
  let provider;
  try { provider = await queryProvider({ checkoutRequestId }); }
  catch (error) { return { verified: false, reason: "PROVIDER_QUERY_FAILED", detail: String(error.message || "").slice(0, 200) }; }
  if (provider?.mode !== "live" || String(provider.responseCode) !== "0" || String(provider.resultCode) !== "0" || provider.checkoutRequestId !== checkoutRequestId) return { verified: false, reason: "PROVIDER_CONFIRMATION_INCOMPLETE" };
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await Purchase.findById(purchaseId).session(session);
      if (!current || current.checkoutRequestId !== checkoutRequestId || current.merchantRequestId !== merchantRequestId) throw new Error("PURCHASE_MISMATCH");
      if (current.paymentStatus === "verified") {
        if (current.mpesaReceipt !== receipt || current.verifiedAmountKes !== amountKes) throw new Error("VERIFIED_PAYMENT_MISMATCH");
        return;
      }
      if (!current.hasUnresolvedPayment || !["pending", "verification_required"].includes(current.paymentStatus)) throw new Error("PURCHASE_NOT_ELIGIBLE");
      await MpesaReceiptClaim.create([{ receipt, purpose: "academic_bid_purchase", referenceId: String(current._id), amountKes, claimedBy: current.userId, evidenceSource: "daraja_provider_confirmation", evidenceReference: checkoutRequestId }], { session });
      const wallet = await Wallet.findOneAndUpdate({ userId: current.userId }, { $setOnInsert: { userId: current.userId }, $inc: { balanceBids: current.bids, totalPurchasedBids: current.bids } }, { session, new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true });
      await Transaction.create([{ userId: current.userId, walletId: wallet._id, type: "BID_PURCHASE", bids: current.bids, previousBalance: wallet.balanceBids - current.bids, newBalance: wallet.balanceBids, reference: `AW-BID-PURCHASE-${current._id}`, description: `Academic Writing bid package: ${current.packageName}`, metadata: { amountKes, receipt, checkoutRequestId } }], { session });
      current.paymentStatus = "verified"; current.hasUnresolvedPayment = false; current.mpesaReceipt = receipt; current.verifiedAmountKes = amountKes; current.verifiedAt = new Date(); await current.save({ session });
    });
    return { verified: true };
  } catch (error) { return { verified: false, reason: error.code === 11000 ? "RECEIPT_ALREADY_USED" : error.message || "TRANSACTION_FAILED" }; }
  finally { await session.endSession(); }
}

module.exports = { verifyAndCreditAcademicBidPurchase };