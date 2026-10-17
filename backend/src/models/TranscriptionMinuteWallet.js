"use strict";

const mongoose = require("mongoose");

const wholeMinutes = {
  validator: Number.isSafeInteger,
  message: "Minute balances must be whole numbers."
};

const schema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true,
    immutable: true
  },
  availableMinutes: {
    type: Number, default: 0, min: 0, validate: wholeMinutes
  },
  reservedMinutes: {
    type: Number, default: 0, min: 0, validate: wholeMinutes
  },
  totalPurchasedMinutes: {
    type: Number, default: 0, min: 0, validate: wholeMinutes
  },
  totalSpentMinutes: {
    type: Number, default: 0, min: 0, validate: wholeMinutes
  },
  totalRefundedMinutes: {
    type: Number, default: 0, min: 0, validate: wholeMinutes
  }
}, {
  timestamps: true,
  versionKey: false
});

module.exports = mongoose.models.TranscriptionMinuteWallet ||
  mongoose.model("TranscriptionMinuteWallet", schema);
