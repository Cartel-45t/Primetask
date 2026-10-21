"use strict";

const mongoose = require("mongoose");

const walletTransactionSchema = new mongoose.Schema(
  {
    membershipPurchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MembershipPurchase",
      default: undefined
    },

    depositId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Deposit",
      default: undefined
    },

    commissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Commission",
      default: undefined
    },

    // Present only for administrator-created wallet adjustments.
    createdByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: undefined
    },

    idempotencyKey: {
      type: String,
      trim: true,
      minlength: 8,
      maxlength: 100,
      default: undefined
    },

    adjustmentField: {
      type: String,
      enum: ["availableBalance", "totalEarnings"],
      default: undefined
    },

    adjustmentDirection: {
      type: String,
      enum: ["credit", "debit"],
      default: undefined
    },

    adjustmentReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: undefined
    },

    adjustmentBeforeCents: {
      type: Number,
      min: 0,
      validate: Number.isSafeInteger,
      default: undefined
    },

    adjustmentAfterCents: {
      type: Number,
      min: 0,
      validate: Number.isSafeInteger,
      default: undefined
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },

    type: {
      type: String,
      enum: [
        "deposit",
        "withdrawal",
        "transfer_in",
        "transfer_out",
        "earning",
        "commission",
        "adjustment",
        "membership_purchase"
      ],
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

    status: {
      type: String,
      enum: ["pending", "completed", "failed", "reversed"],
      default: "pending",
      required: true
    },

    reference: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null
    },

    description: {
      type: String,
      trim: true,
      maxlength: 240,
      default: ""
    },

    relatedUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },

    completedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

walletTransactionSchema.index({
  userId: 1,
  createdAt: -1
});

walletTransactionSchema.index(
  { createdByAdminId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      createdByAdminId: { $type: "objectId" },
      idempotencyKey: { $type: "string" }
    },
    name: "unique_admin_wallet_adjustment_idempotency"
  }
);

walletTransactionSchema.index(
  { depositId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      depositId: { $type: "objectId" }
    },
    name: "unique_deposit_wallet_ledger"
  }
);

walletTransactionSchema.index(
  { commissionId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      commissionId: { $type: "objectId" }
    },
    name: "unique_commission_wallet_ledger"
  }
);

walletTransactionSchema.index(
  { membershipPurchaseId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      membershipPurchaseId: { $type: "objectId" }
    },
    name: "unique_membership_purchase_wallet_ledger"
  }
);

module.exports = mongoose.model(
  "WalletTransaction",
  walletTransactionSchema
);
