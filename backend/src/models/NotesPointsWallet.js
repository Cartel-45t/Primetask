"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true,
    immutable: true
  },
  balancePoints: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
    validate: Number.isSafeInteger
  },
  totalPurchasedPoints: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
    validate: Number.isSafeInteger
  },
  totalSpentPoints: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
    validate: Number.isSafeInteger
  }
}, {
  timestamps: true,
  versionKey: false
});

module.exports = mongoose.models.NotesPointsWallet ||
  mongoose.model("NotesPointsWallet", schema);
