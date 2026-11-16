"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true, index: true },
  walletId: { type: mongoose.Schema.Types.ObjectId, ref: "AcademicBidWallet", required: true, immutable: true },
  type: { type: String, enum: ["BID_PURCHASE", "APPLICATION_DEDUCTION", "ADMIN_CREDIT", "ADMIN_DEBIT", "PAYMENT_REVERSAL"], required: true, immutable: true },
  bids: { type: Number, required: true, validate: v => Number.isSafeInteger(v) && v !== 0, immutable: true },
  previousBalance: { type: Number, required: true, min: 0, validate: Number.isSafeInteger, immutable: true },
  newBalance: { type: Number, required: true, min: 0, validate: Number.isSafeInteger, immutable: true },
  reference: { type: String, required: true, unique: true, trim: true, maxlength: 180, immutable: true },
  description: { type: String, required: true, trim: true, maxlength: 300, immutable: true },
  jobId: { type: mongoose.Schema.Types.ObjectId, ref: "AcademicJob", default: null, immutable: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: undefined, immutable: true }
}, { timestamps: true, versionKey: false });
schema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.models.AcademicBidTransaction || mongoose.model("AcademicBidTransaction", schema);