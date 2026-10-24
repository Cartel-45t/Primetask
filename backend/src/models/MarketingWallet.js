"use strict";

const mongoose = require("mongoose");

const marketingWalletSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true
  },
  currency: {
    type: String,
    enum: ["USD"],
    default: "USD",
    immutable: true
  },
  balanceCents: {
    type: Number,
    min: 0,
    default: 0,
    required: true,
    validate: Number.isSafeInteger
  },
  lifetimeRewardsCents: {
    type: Number,
    min: 0,
    default: 0,
    required: true,
    validate: Number.isSafeInteger
  }
}, {
  timestamps: true,
  versionKey: false
});

module.exports = mongoose.model("MarketingWallet", marketingWalletSchema);
