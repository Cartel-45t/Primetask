"use strict";

const mongoose = require("mongoose");

const transferRequestSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },

    oldRegistrationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeviceRegistration",
      required: true
    },

    oldDeviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Device",
      required: true
    },

    proposedDeviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Device",
      required: true
    },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending",
      required: true
    },

    requestIp: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null
    },

    adminIpReference: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null
    },

    ipReferenceUpdatedAt: {
      type: Date,
      default: null
    },

    ipReferenceUpdatedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },

    ipReferenceReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null
    },

    requestUserAgent: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null
    },

    requestCount: {
      type: Number,
      default: 1,
      min: 1
    },

    failedAttempts: {
      type: Number,
      default: 0,
      min: 0
    },

    firstRequestedAt: {
      type: Date,
      default: Date.now,
      required: true
    },

    lastRequestedAt: {
      type: Date,
      default: Date.now,
      required: true
    },

    lastAttemptAt: {
      type: Date,
      default: null
    },

    reviewedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },

    reviewedAt: {
      type: Date,
      default: null
    },

    reviewReason: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null
    },

    approvedAt: {
      type: Date,
      default: null
    },

    rejectedAt: {
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

// Prevent multiple pending transfer requests for one account.
transferRequestSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "pending" },
    name: "one_pending_device_transfer_per_account"
  }
);

transferRequestSchema.index({ userId: 1, createdAt: -1 });
transferRequestSchema.index({ status: 1, createdAt: -1 });
transferRequestSchema.index({ proposedDeviceId: 1, createdAt: -1 });
transferRequestSchema.index({ oldDeviceId: 1, createdAt: -1 });

module.exports = mongoose.model(
  "DeviceTransferRequest",
  transferRequestSchema
);
