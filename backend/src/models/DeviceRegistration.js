"use strict";

const mongoose = require("mongoose");

const registrationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },

    deviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Device",
      required: true,
      index: true
    },

    status: {
      type: String,
      enum: ["active", "revoked"],
      default: "active",
      required: true
    },

    registeredAt: {
      type: Date,
      default: Date.now,
      required: true
    },

    lastSeenAt: {
      type: Date,
      default: Date.now
    },

    revokedAt: {
      type: Date,
      default: null
    },

    revokedReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null
    },

    reviewedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

// A browser can be registered to multiple accounts.
// Each account can have only one active device registration.
registrationSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "active" },
    name: "one_active_device_per_account"
  }
);

// Keep registration history without preventing a previously revoked
// device from being registered again. The partial unique index above
// remains responsible for enforcing one active device per account.
registrationSchema.index(
  { userId: 1, deviceId: 1 },
  { name: "account_device_registration_history" }
);

registrationSchema.index({ status: 1, lastSeenAt: -1 });

module.exports = mongoose.model(
  "DeviceRegistration",
  registrationSchema
);
