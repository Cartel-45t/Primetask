"use strict";

const mongoose = require("mongoose");

const emailVerificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true
    },

    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254
    },

    codeHash: {
      type: String,
      required: true,
      select: false
    },

    pendingCodeHash: {
      type: String,
      default: undefined,
      select: false
    },

    pendingExpiresAt: {
      type: Date,
      default: undefined
    },

    activeExpiresAt: {
      type: Date,
      default: undefined
    },

    expiresAt: {
      type: Date,
      required: true
    },

    attempts: {
      type: Number,
      default: 0,
      min: 0
    },

    sentAt: {
      type: Date,
      required: true
    },

    resendWindowStartedAt: {
      type: Date,
      required: true
    },

    resendCount: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

emailVerificationSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

module.exports = mongoose.model(
  "EmailVerification",
  emailVerificationSchema
);
