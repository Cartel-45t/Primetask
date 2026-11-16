"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, immutable: true },
  balanceBids: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  totalPurchasedBids: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  totalSpentBids: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  totalAdjustedBids: { type: Number, default: 0, validate: Number.isSafeInteger }
}, { timestamps: true, versionKey: false });

module.exports = mongoose.models.AcademicBidWallet || mongoose.model("AcademicBidWallet", schema);