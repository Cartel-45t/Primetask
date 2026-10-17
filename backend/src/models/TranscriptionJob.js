"use strict";

const mongoose = require("mongoose");

const transcriptionJobSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 180 },
  description: { type: String, required: true, trim: true, maxlength: 10000 },
  audioAssetUrl: { type: String, default: null, trim: true, maxlength: 2048 },
  audioPublicId: { type: String, default: null, trim: true, maxlength: 300 },
  durationMinutes: { type: Number, required: true, min: 1, max: 10000 },
  rewardCents: {
    type: Number,
    required: true,
    min: 1,
    validate: Number.isSafeInteger
  },
  instructions: { type: String, default: "", trim: true, maxlength: 10000 },
  status: {
    type: String,
    enum: ["draft", "open", "awarded", "submitted", "completed", "closed"],
    default: "draft",
    index: true
  },
  assignedUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
    index: true
  },
  createdByAdminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  dueAt: { type: Date, default: null },
  completedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });

transcriptionJobSchema.index({ status: 1, createdAt: -1 });
transcriptionJobSchema.index({ assignedUserId: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.models.TranscriptionJob ||
  mongoose.model("TranscriptionJob", transcriptionJobSchema);
