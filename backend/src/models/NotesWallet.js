"use strict";

const mongoose = require("mongoose");

const nonNegativeCents = {
  validator: Number.isSafeInteger,
  message: "Wallet amounts must be whole USD cents."
};

const schema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true,
    immutable: true
  },
  availableBalanceCents: {
    type: Number, default: 0, min: 0, validate: nonNegativeCents
  },
  reservedBalanceCents: {
    type: Number, default: 0, min: 0, validate: nonNegativeCents
  },
  totalPurchasedCents: {
    type: Number, default: 0, min: 0, validate: nonNegativeCents
  },
  totalSpentCents: {
    type: Number, default: 0, min: 0, validate: nonNegativeCents
  },
  totalEarningsCents: {
    type: Number, default: 0, min: 0, validate: nonNegativeCents
  }
}, {
  timestamps: true,
  versionKey: false
});

module.exports = mongoose.models.NotesWallet ||
  mongoose.model("NotesWallet", schema);
