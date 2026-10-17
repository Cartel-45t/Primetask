"use strict";

const mongoose = require("mongoose");

const membershipSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
      immutable: true
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
      trim: true,
      lowercase: true,
      immutable: true
    },
    priceCents: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
      immutable: true
    },
    currency: {
      type: String,
      enum: ["USD"],
      default: "USD",
      immutable: true
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
      immutable: true
    },
    status: {
      type: String,
      enum: ["pending", "active", "expired", "cancelled"],
      default: "pending",
      required: true,
      index: true
    },
    purchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MembershipPurchase",
      default: null,
      immutable: true
    },
    grantSource: {
      type: String,
      enum: ["purchase", "admin_award"],
      default: "purchase",
      immutable: true
    },
    grantReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: ""
    },
    grantedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: undefined,
      immutable: true
    },
    grantIdempotencyKey: {
      type: String,
      trim: true,
      minlength: 8,
      maxlength: 100,
      default: undefined,
      immutable: true
    },
    startsAt: {
      type: Date,
      default: null
    },
    expiresAt: {
      type: Date,
      default: null,
      index: true
    },
    activatedAt: {
      type: Date,
      default: null
    },
    cancelledAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

membershipSchema.index(
  { purchaseId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      purchaseId: { $type: "objectId" }
    },
    name: "unique_membership_purchase"
  }
);

membershipSchema.index(
  { grantedByAdminId: 1, grantIdempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      grantSource: "admin_award",
      grantedByAdminId: { $type: "objectId" },
      grantIdempotencyKey: { $type: "string" }
    },
    name: "unique_admin_membership_award_request"
  }
);

membershipSchema.index({
  userId: 1,
  status: 1,
  expiresAt: -1
});

module.exports = mongoose.model("Membership", membershipSchema);
