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
    ref: "DataEntryWallet",
    required: true,
    immutable: true
  },
  type: {
    type: String,
    enum: [
      "task_earning",
      "admin_adjustment",
      "withdrawal",
      "withdrawal_reversal"
    ],
    required: true,
    immutable: true
  },
  amountCents: {
    type: Number,
    required: true,
    validate: {
      validator: Number.isSafeInteger,
      message: "Transaction amounts must be whole USD cents."
    },
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
  description: {
    type: String,
    default: "",
    trim: true,
    maxlength: 500,
    immutable: true
  },
  submissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "DataEntrySubmission",
    default: null,
    immutable: true
  },
  withdrawalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "DataEntryWithdrawal",
    default: null,
    immutable: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: undefined,
    immutable: true
  }
}, {
  timestamps: true,
  versionKey: false
});

schema.index({ userId: 1, createdAt: -1 });
schema.index(
  { submissionId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: {
      submissionId: { $type: "objectId" },
      type: "task_earning"
    }
  }
);

module.exports = mongoose.models.DataEntryTransaction ||
  mongoose.model("DataEntryTransaction", schema);
