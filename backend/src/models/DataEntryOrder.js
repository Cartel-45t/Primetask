"use strict";

const mongoose = require("mongoose");

const dataEntryOrderSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 180
  },
  description: {
    type: String,
    default: "",
    trim: true,
    maxlength: 10000
  },
  category: {
    type: String,
    enum: ["spreadsheet", "document", "research", "other"],
    required: true
  },
  instructions: {
    type: String,
    default: "",
    trim: true,
    maxlength: 15000
  },
  rewardCents: {
    type: Number,
    required: true,
    min: 1,
    validate: Number.isSafeInteger
  },
  requiredBids: {
    type: Number,
    required: true,
    min: 1,
    validate: Number.isSafeInteger
  },
  timeLimitMinutes: {
    type: Number,
    required: true,
    min: 1,
    validate: Number.isSafeInteger
  },
  acceptedFileFormats: {
    type: [String],
    default: [],
    validate: {
      validator: formats =>
        formats.length <= 20 &&
        formats.every(format =>
          typeof format === "string" &&
          /^[a-z0-9]{1,10}$/i.test(format)
        ),
      message: "Invalid accepted file formats."
    }
  },
  status: {
    type: String,
    enum: ["draft", "published", "assigned", "submitted", "revision_requested", "completed", "cancelled"],
    default: "draft",
    index: true
  },
  assignedUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
    index: true
  },
  claimedAt: {
    type: Date,
    default: null
  },
  assignmentExpiresAt: {
    type: Date,
    default: null,
    index: true
  },
  submittedAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  },
  createdByAdminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  publishedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true,
  versionKey: false
});

dataEntryOrderSchema.index({ status: 1, createdAt: -1 });
dataEntryOrderSchema.index({ assignedUserId: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.models.DataEntryOrder ||
  mongoose.model("DataEntryOrder", dataEntryOrderSchema);
