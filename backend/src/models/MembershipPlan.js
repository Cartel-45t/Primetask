"use strict";

const mongoose = require("mongoose");

const SERVICES = [
  "transcription",
  "note-taking",
  "data-entry",
  "academic-writing"
];

const membershipPlanSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: /^[a-z0-9_-]+$/,
      maxlength: 60
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: 1000
    },
    priceCents: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "Membership price must be integer USD cents."
      }
    },
    // Explicit M-Pesa checkout amount in whole Kenyan shillings.
    // This is configured by an administrator; it is never derived from USD.
    mpesaAmountKes: {
      type: Number,
      default: null,
      min: 1,
      validate: {
        validator: value =>
          value === null || value === undefined ||
          (Number.isSafeInteger(value) && value > 0),
        message: "M-Pesa amount must be a positive whole number of KSh."
      }
    },
    currency: {
      type: String,
      enum: ["USD"],
      default: "USD",
      immutable: true
    },
    durationDays: {
      type: Number,
      required: true,
      min: 1,
      max: 3660,
      validate: Number.isSafeInteger
    },
    services: {
      type: [{
        type: String,
        enum: SERVICES
      }],
      default: [],
      validate: {
        validator: values =>
          Array.isArray(values) &&
          new Set(values).size === values.length,
        message: "A service can only appear once in a plan."
      }
    },

    // Fixed commission amounts in USD cents, one per referral level.
    // Index 0 = level 1; index 1 = level 2;
    // index 2 = level 3; index 3 = level 4.
    commissionAmountsCents: {
      type: [{
        type: Number,
        min: 0,
        validate: Number.isSafeInteger
      }],
      default: [0, 0, 0, 0],
      validate: {
        validator: values =>
          Array.isArray(values) &&
          values.length === 4 &&
          values.every(Number.isSafeInteger) &&
          values.every(value => value >= 0),
        message:
          "Provide exactly four non-negative integer USD-cent commission amounts."
      }
    },
    commissionEnabled: {
      type: Boolean,
      default: false
    },
    active: {
      type: Boolean,
      default: false,
      index: true
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

// Prevent enabled commissions from exceeding the plan price.
membershipPlanSchema.pre("validate", function () {
  if (
    this.commissionEnabled &&
    Array.isArray(this.commissionAmountsCents) &&
    this.commissionAmountsCents.length === 4 &&
    this.commissionAmountsCents.every(
      value => Number.isSafeInteger(value) && value >= 0
    ) &&
    Number.isSafeInteger(this.priceCents) &&
    this.commissionAmountsCents.reduce(
      (sum, amount) => sum + amount,
      0
    ) > this.priceCents
  ) {
    this.invalidate(
      "commissionAmountsCents",
      "Total commissions cannot exceed the membership plan price."
    );
  }
});

membershipPlanSchema.index({ active: 1, priceCents: 1 });

module.exports = mongoose.model("MembershipPlan", membershipPlanSchema);
