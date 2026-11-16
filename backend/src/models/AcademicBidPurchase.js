"use strict";

const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");

const schema = new mongoose.Schema({
  purchaseReference: { type: String, required: true, unique: true, immutable: true, default: () => `PTW-AW-BID-${randomUUID()}`, maxlength: 100 },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true, index: true },
  idempotencyKey: { type: String, required: true, trim: true, minlength: 8, maxlength: 150, immutable: true },
  packageId: { type: mongoose.Schema.Types.ObjectId, ref: "AcademicBidPackage", required: true, immutable: true },
  packageName: { type: String, required: true, maxlength: 120, immutable: true },
  bids: { type: Number, required: true, min: 1, validate: Number.isSafeInteger, immutable: true },
  expectedAmountKes: { type: Number, required: true, min: 1, validate: Number.isSafeInteger, immutable: true },
  phoneNumber: { type: String, required: true, match: /^254[17]\d{8}$/, immutable: true },
  paymentStatus: { type: String, enum: ["pending", "verification_required", "verified", "failed", "cancelled"], default: "pending", index: true },
  hasUnresolvedPayment: { type: Boolean, default: true, required: true },
  merchantRequestId: { type: String, default: null, maxlength: 150 },
  checkoutRequestId: { type: String, default: null, maxlength: 150 },
  mpesaReceipt: { type: String, default: null, trim: true, uppercase: true, maxlength: 30 },
  verifiedAmountKes: { type: Number, default: null, min: 1, validate: v => v == null || Number.isSafeInteger(v) },
  verifiedAt: { type: Date, default: null },
  failureCode: { type: String, default: null, maxlength: 100 }
}, { timestamps: true, versionKey: false });
schema.index({ userId: 1, idempotencyKey: 1 }, { unique: true, name: "unique_academic_bid_purchase_idempotency" });
schema.index({ checkoutRequestId: 1 }, { unique: true, partialFilterExpression: { checkoutRequestId: { $type: "string" } }, name: "unique_academic_bid_checkout" });
schema.index({ mpesaReceipt: 1 }, { unique: true, partialFilterExpression: { mpesaReceipt: { $type: "string" } }, name: "unique_academic_bid_receipt" });
schema.index({ userId: 1 }, { unique: true, partialFilterExpression: { hasUnresolvedPayment: true }, name: "unique_unresolved_academic_bid_purchase" });

module.exports = mongoose.models.AcademicBidPurchase || mongoose.model("AcademicBidPurchase", schema);