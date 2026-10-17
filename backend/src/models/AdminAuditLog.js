"use strict";

const mongoose = require("mongoose");

const adminAuditLogSchema = new mongoose.Schema({
  adminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  targetUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  action: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80
  },
  reason: {
    type: String,
    required: true,
    trim: true,
    maxlength: 500
  },
  before: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  after: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  ipAddress: {
    type: String,
    maxlength: 100,
    default: null
  }
}, {
  timestamps: true,
  versionKey: false
});

adminAuditLogSchema.index({ targetUserId: 1, createdAt: -1 });

module.exports = mongoose.model("AdminAuditLog", adminAuditLogSchema);
