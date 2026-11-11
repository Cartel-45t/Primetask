"use strict";

const mongoose = require("mongoose");

const emailVerificationThrottleSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true
    },

    windowStartedAt: {
      type: Date,
      required: true
    },

    resendCount: {
      type: Number,
      default: 0,
      min: 0
    },

    lastSentAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

module.exports = mongoose.model(
  "EmailVerificationThrottle",
  emailVerificationThrottleSchema
);
