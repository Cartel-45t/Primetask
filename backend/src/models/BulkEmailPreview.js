"use strict";

const mongoose = require("mongoose");

const bulkEmailPreviewSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  audience: { type: String, enum: ["active", "inactive", "all"], required: true },
  recipientIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  recipientHash: { type: String, required: true },
  eligibleCount: { type: Number, required: true, min: 0 },
  excludedCount: { type: Number, required: true, min: 0 },
  duplicateCount: { type: Number, required: true, min: 0 },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  usedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model("BulkEmailPreview", bulkEmailPreviewSchema);