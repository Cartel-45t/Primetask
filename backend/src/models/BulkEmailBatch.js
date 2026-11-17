"use strict";

const mongoose = require("mongoose");

const bulkEmailBatchSchema = new mongoose.Schema({
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "BulkEmailCampaign", required: true, index: true },
  batchNumber: { type: Number, required: true, min: 0 },
  recipientIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  status: { type: String, enum: ["queued", "sending", "sent", "failed"], default: "queued", index: true },
  lockToken: { type: String, default: null },
  lockedAt: { type: Date, default: null },
  sentCount: { type: Number, default: 0, min: 0 },
  expectedRecipientCount: { type: Number, default: 0, min: 0 },
  failedCount: { type: Number, default: 0, min: 0 },
  skippedCount: { type: Number, default: 0, min: 0 },
  resendSegmentId: { type: String, default: "", maxlength: 100 },
  resendBroadcastId: { type: String, default: "", maxlength: 100 },
  error: { type: String, default: "", maxlength: 500 }
}, { timestamps: true, versionKey: false });

bulkEmailBatchSchema.index({ campaignId: 1, batchNumber: 1 }, { unique: true });
bulkEmailBatchSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model("BulkEmailBatch", bulkEmailBatchSchema);