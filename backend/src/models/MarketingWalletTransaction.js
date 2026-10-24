"use strict";

const mongoose = require("mongoose");

const marketingWalletTransactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ["chat_streak_reward"],
    required: true
  },
  amountCents: {
    type: Number,
    required: true,
    min: 1,
    validate: Number.isSafeInteger
  },
  currency: {
    type: String,
    enum: ["USD"],
    default: "USD",
    immutable: true
  },
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ChatConversation",
    required: true
  },
  qualifyingDayKey: {
    type: String,
    required: true,
    match: /^\d{4}-\d{2}-\d{2}$/
  },
  idempotencyKey: {
    type: String,
    required: true,
    unique: true,
    immutable: true,
    maxlength: 160
  },
  description: {
    type: String,
    default: "PrimeTask Chat streak reward",
    maxlength: 240
  }
}, {
  timestamps: true,
  versionKey: false
});

marketingWalletTransactionSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model(
  "MarketingWalletTransaction",
  marketingWalletTransactionSchema
);
