"use strict";

const mongoose = require("mongoose");

const securityEventSchema = new mongoose.Schema(
  {
    eventType: {
      type: String,
      required: true,
      enum: [
        "login_success",
        "login_failed",
        "logout",
        "session_revoked",
        "device_registered",
        "device_transfer_requested",
        "device_transfer_failed",
        "device_transfer_completed",
        "device_transfer_rejected",
        "device_transfer_ip_reference_updated",
        "device_banned",
        "device_unbanned",
        "device_access_denied",
        "password_reset_requested",
        "password_reset_completed",
        "email_verification_sent",
        "email_verified",
        "rate_limit_triggered",
        "suspicious_request",
        "admin_security_action"
      ]
    },

    severity: {
      type: String,
      enum: ["info", "warning", "critical"],
      default: "info",
      required: true
    },

    outcome: {
      type: String,
      enum: ["success", "denied", "failed", "pending"],
      required: true
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true
    },

    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },

    targetUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },

    deviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Device",
      default: null,
      index: true
    },

    ipAddress: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null
    },

    countryCode: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 2,
      default: null
    },

    region: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null
    },

    city: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null
    },

    userAgent: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null
    },

    method: {
      type: String,
      uppercase: true,
      maxlength: 10,
      default: null
    },

    path: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null
    },

    statusCode: {
      type: Number,
      min: 100,
      max: 599,
      default: null
    },

    durationMs: {
      type: Number,
      min: 0,
      default: null
    },

    requestId: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null
    },

    message: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null
    },

    sequence: {
      type: Number,
      required: true,
      min: 1,
      unique: true
    },

    previousHash: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/
    },

    eventHash: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/
    }
  },
  {
    timestamps: true,
    versionKey: false,
    strict: "throw"
  }
);

securityEventSchema.index({ createdAt: -1 });
securityEventSchema.index({ userId: 1, createdAt: -1 });
securityEventSchema.index({ eventType: 1, createdAt: -1 });
securityEventSchema.index({ severity: 1, createdAt: -1 });
securityEventSchema.index({ ipAddress: 1, createdAt: -1 });

module.exports = mongoose.model("SecurityEvent", securityEventSchema);
