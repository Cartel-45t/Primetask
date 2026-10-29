"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  requestId: { type: String, required: true, unique: true, immutable: true },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
    immutable: true
  },
  amountCents: {
    type: Number,
    required: true,
    min: 1,
    validate: Number.isSafeInteger,
    immutable: true
  },
  currency: { type: String, enum: ["USD"], default: "USD", immutable: true },
  exchangeRateKesPerUsd: {
    type: Number, required: true, min: 1, max: 1000, immutable: true
  },
  payoutAmountKes: {
    type: Number, required: true, min: 1,
    validate: Number.isSafeInteger, immutable: true
  },
  phoneNumber: {
    type: String, required: true, match: /^254[17]\d{8}$/, immutable: true
  },
  status: {
    type: String,
    enum: [
      "pending_review", "approved", "processing",
      "reconciliation_required", "paid", "rejected"
    ],
    default: "pending_review",
    index: true
  },
  b2cOriginatorConversationId: { type: String, default: null, maxlength: 100 },
  b2cConversationId: { type: String, default: null, maxlength: 150 },
  b2cInitiationState: {
    type: String,
    enum: ["not_started", "submitting", "accepted", "unknown", "rejected", "succeeded"],
    default: "not_started"
  },
  b2cInitiatedAt: { type: Date, default: null },
  b2cResultCode: { type: Number, default: null },
  b2cResultDescription: { type: String, default: null, maxlength: 500 },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reviewedAt: { type: Date, default: null },
  mpesaReceipt: { type: String, default: null, trim: true, uppercase: true, maxlength: 100 },
  adminNote: { type: String, default: "", trim: true, maxlength: 300 }
}, { timestamps: true, versionKey: false });

schema.index({ userId: 1, createdAt: -1 });
schema.index(
  { b2cOriginatorConversationId: 1 },
  {
    unique: true,
    partialFilterExpression: { b2cOriginatorConversationId: { $type: "string" } }
  }
);
schema.index(
  { mpesaReceipt: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "paid", mpesaReceipt: { $type: "string" } }
  }
);

module.exports = mongoose.models.NotesWithdrawal ||
  mongoose.model("NotesWithdrawal", schema);
