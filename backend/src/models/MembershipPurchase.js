"use strict";

const mongoose = require("mongoose");
const { randomUUID } = require("crypto");

const membershipPurchaseSchema = new mongoose.Schema(
  {
    purchaseReference: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      default: () => `PTW-MP-${randomUUID()}`,
      maxlength: 80
    },

    idempotencyKey: {
      type: String,
      required: true,
      immutable: true,
      trim: true,
      minlength: 8,
      maxlength: 150
    },

    purchaserUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
      index: true
    },

    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MembershipPlan",
      required: true,
      immutable: true
    },

    planKey: {
      type: String,
      required: true,
      immutable: true,
      trim: true,
      lowercase: true,
      maxlength: 80
    },

    // Monetary values are stored as integer minor units.
    // USD is the platform currency; KSh is only the Daraja payment amount.
    priceCents: {
      type: Number,
      required: true,
      immutable: true,
      min: 1,
      validate: Number.isSafeInteger
    },

    currency: {
      type: String,
      enum: ["USD"],
      required: true,
      default: "USD",
      immutable: true
    },

    expectedAmountKes: {
      type: Number,
      required: true,
      immutable: true,
      min: 1,
      validate: Number.isSafeInteger
    },

    // Immutable snapshot of the plan terms at purchase time.
    durationDays: {
      type: Number,
      required: true,
      immutable: true,
      min: 1,
      max: 3660,
      validate: Number.isSafeInteger
    },

    services: {
      type: [{
        type: String,
        enum: [
          "transcription",
          "note-taking",
          "data-entry",
          "academic-writing"
        ]
      }],
      required: true,
      immutable: true,
      validate: {
        validator: values =>
          Array.isArray(values) &&
          new Set(values).size === values.length,
        message: "Purchase services must be unique."
      }
    },

    commissionEnabledSnapshot: {
      type: Boolean,
      required: true,
      immutable: true,
      default: false
    },

    // Fixed commission amounts copied from the plan at purchase time.
    // Index 0 = referral level 1; index 3 = referral level 4.
    // Values are integer USD cents, not percentages.
    commissionAmountsCentsSnapshot: {
      type: [{
        type: Number,
        min: 0,
        validate: Number.isSafeInteger
      }],
      required: true,
      immutable: true,
      default: [0, 0, 0, 0],
      validate: {
        validator: values =>
          Array.isArray(values) &&
          values.length === 4 &&
          values.every(Number.isSafeInteger) &&
          values.every(value => value >= 0),
        message:
          "Purchase commission snapshots must contain four non-negative integer USD-cent amounts."
      }
    },

    phoneNumber: {
      type: String,
      required: true,
      trim: true,
      match: /^254[17]\d{8}$/
    },

    paymentStatus: {
      type: String,
      enum: [
        "pending",
        "verification_required",
        "verified",
        "failed",
        "cancelled"
      ],
      default: "pending",
      required: true,
      index: true
    },

    merchantRequestId: {
      type: String,
      default: null,
      maxlength: 150
    },

    checkoutRequestId: {
      type: String,
      default: null,
      maxlength: 150
    },

    mpesaReceipt: {
      type: String,
      default: null,
      trim: true,
      uppercase: true,
      maxlength: 30
    },

    verifiedAmountKes: {
      type: Number,
      default: null,
      min: 1,
      validate: {
        validator: value =>
          value === null || Number.isSafeInteger(value),
        message: "Verified payment amount must be a whole number of KSh."
      }
    },

    verificationMethod: {
      type: String,
      enum: ["daraja_reconciliation", "provider_confirmation", "admin_manual_reconciliation"],
      default: null
    },

    verifiedAt: {
      type: Date,
      default: null
    },

    verificationReference: {
      type: String,
      default: null,
      maxlength: 150
    },

    membershipId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Membership",
      default: null
    },

    activatedAt: {
      type: Date,
      default: null
    },

    failureCode: {
      type: String,
      default: null,
      maxlength: 80
    },

    failureDescription: {
      type: String,
      default: "",
      maxlength: 500
    },

    reconciliationAttempts: {
      type: Number,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger
    },

    lastReconciledAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

membershipPurchaseSchema.index(
  { purchaserUserId: 1, idempotencyKey: 1 },
  {
    unique: true,
    name: "unique_membership_purchase_idempotency"
  }
);

membershipPurchaseSchema.index(
  { checkoutRequestId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      checkoutRequestId: { $type: "string" }
    },
    name: "unique_membership_purchase_checkout"
  }
);

membershipPurchaseSchema.index(
  { mpesaReceipt: 1 },
  {
    unique: true,
    partialFilterExpression: {
      mpesaReceipt: { $type: "string" }
    },
    name: "unique_membership_purchase_receipt"
  }
);

membershipPurchaseSchema.index({
  paymentStatus: 1,
  createdAt: 1
});

module.exports = mongoose.model(
  "MembershipPurchase",
  membershipPurchaseSchema
);
