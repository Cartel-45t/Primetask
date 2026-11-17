"use strict";

const mongoose = require("mongoose");

const bulkEmailCampaignSchema = new mongoose.Schema({
  subject: { type: String, required: true, trim: true, maxlength: 160 },
  message: { type: String, required: true, trim: true, maxlength: 12000 },
  audience: { type: String, enum: ["active", "inactive", "all"], required: true },
  status: {
    type: String,
    enum: ["queued", "sending", "completed", "completed_with_errors", "failed"],
    default: "queued",
    index: true
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  recipientCount: { type: Number, required: true, min: 0 },
  sentCount: { type: Number, default: 0, min: 0 },
  failedCount: { type: Number, default: 0, min: 0 },
  skippedCount: { type: Number, default: 0, min: 0 },
  totalBatches: { type: Number, required: true, min: 0 },
  lastError: { type: String, default: "", maxlength: 500 },
  finishedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model("BulkEmailCampaign", bulkEmailCampaignSchema);