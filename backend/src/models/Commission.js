"use strict";

const mongoose = require("mongoose");

const commissionSchema = new mongoose.Schema(
  {
    membershipId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Membership",
      required: true,
      immutable: true
    },

    beneficiaryUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
      index: true
    },

    purchaserUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true
    },

    level: {
      type: Number,
      required: true,
      min: 1,
      max: 4,
      validate: Number.isSafeInteger,
      immutable: true
    },

    amountCents: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
      immutable: true
    },

    currency: {
      type: String,
      enum: ["USD"],
      default: "USD",
      immutable: true
    },

    status: {
      type: String,
      enum: ["pending", "paid", "reversed"],
      default: "pending",
      required: true,
      index: true
    },

    walletTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WalletTransaction",
      default: null
    },

    paidAt: {
      type: Date,
      default: null
    },

    reversedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

commissionSchema.index(
  { membershipId: 1, beneficiaryUserId: 1, level: 1 },
  {
    unique: true,
    name: "unique_membership_beneficiary_level"
  }
);

commissionSchema.index({
  beneficiaryUserId: 1,
  createdAt: -1
});

module.exports = mongoose.model("Commission", commissionSchema);
