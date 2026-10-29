"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    immutable: true,
    index: true
  },
  walletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "TranscriptionMinuteWallet",
    required: true,
    immutable: true
  },
  type: {
    type: String,
    enum: [
      "purchase_credit",
      "job_claim_debit",
      "job_reservation",
      "job_debit",
      "reservation_release",
      "refund",
      "admin_adjustment"
    ],
    required: true,
    immutable: true
  },
  minutes: {
    type: Number,
    required: true,
    min: 1,
    validate: Number.isSafeInteger,
    immutable: true
  },
  reference: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    maxlength: 180,
    immutable: true
  },
  purchaseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "TranscriptionMinutePurchase",
    default: null,
    immutable: true
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "TranscriptionJob",
    default: null,
    immutable: true
  },
  claimExpiresAt: {
    type: Date,
    default: null,
    immutable: true
  },
  description: {
    type: String,
    default: "",
    trim: true,
    maxlength: 500,
    immutable: true
  },
  createdByAdminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
    immutable: true
  }
}, {
  timestamps: true,
  versionKey: false
});

schema.index({ userId: 1, createdAt: -1 });

schema.index(
  { purchaseId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: {
      purchaseId: { $type: "objectId" },
      type: "purchase_credit"
    },
    name: "unique_minute_purchase_credit"
  }
);

module.exports = mongoose.models.TranscriptionMinuteTransaction ||
  mongoose.model("TranscriptionMinuteTransaction", schema);
