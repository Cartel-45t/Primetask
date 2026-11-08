"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
    immutable: true
  },
  walletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "DataEntryBidWallet",
    required: true,
    immutable: true
  },
  type: {
    type: String,
    enum: [
      "purchase_credit",
      "job_claim",
      "admin_adjustment"
    ],
    required: true,
    immutable: true
  },
  bids: {
    type: Number,
    required: true,
    validate: {
      validator: value =>
        Number.isSafeInteger(value) && value !== 0,
      message: "Bid transactions must be non-zero whole numbers."
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
  purchaseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "DataEntryBidPurchase",
    default: null,
    immutable: true
  },
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "DataEntryOrder",
    default: null,
    immutable: true
  },
  description: {
    type: String,
    required: true,
    trim: true,
    maxlength: 300,
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

module.exports = mongoose.models.DataEntryBidTransaction ||
  mongoose.model("DataEntryBidTransaction", schema);
