"use strict";

const mongoose = require("mongoose");

const deviceSchema = new mongoose.Schema(
  {
    // Global browser/device identity, independent of any account.
    deviceKeyHash: {
      type: String,
      required: true,
      unique: true,
      select: false,
      match: /^[a-f0-9]{64}$/
    },

    status: {
      type: String,
      enum: ["active", "banned"],
      default: "active",
      required: true,
      index: true
    },

    deviceLabel: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null
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

    lastKnownIp: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null
    },

    lastUserAgent: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null
    },

    bannedAt: {
      type: Date,
      default: null
    },

    banReason: {
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

deviceSchema.index({ status: 1, lastSeenAt: -1 });

module.exports = mongoose.model("Device", deviceSchema);
