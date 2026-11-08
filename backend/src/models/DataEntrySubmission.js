"use strict";

const mongoose = require("mongoose");

const reviewHistorySchema = new mongoose.Schema({
  reviewNote: {
    type: String,
    default: "",
    trim: true,
    maxlength: 2000
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  reviewedAt: {
    type: Date,
    required: true
  },
  decision: {
    type: String,
    enum: ["approved", "rejected", "revision_requested"],
    required: true
  }
}, { _id: false });

const schema = new mongoose.Schema({
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "DataEntryOrder",
    required: true,
    immutable: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    immutable: true,
    index: true
  },
  orderTitle: {
    type: String,
    required: true,
    immutable: true,
    maxlength: 180
  },
  submissionText: {
    type: String,
    default: "",
    trim: true,
    maxlength: 200000
  },
  submissionLink: {
    type: String,
    default: "",
    trim: true,
    maxlength: 2048,
    validate: {
      validator(value) {
        if (!value) return true;
        try {
          const parsed = new URL(value);
          return parsed.protocol === "https:" &&
            Boolean(parsed.hostname) &&
            !parsed.username &&
            !parsed.password;
        } catch {
          return false;
        }
      },
      message: "Submission link must be a valid HTTPS URL."
    }
  },
  documentPublicId: {
    type: String,
    default: null,
    maxlength: 500,
    validate: {
      validator(value) {
        if (!value) return true;
        return /^primetask-workspace\/data-entry\/submissions\/[0-9a-f-]{36}\.(xlsx|csv)$/i.test(value);
      },
      message: "Invalid Data Entry submission document."
    }
  },
  documentOriginalName: {
    type: String,
    default: "",
    trim: true,
    maxlength: 255
  },
  documentBytes: {
    type: Number,
    default: null,
    min: 1,
    validate: value => value == null || Number.isSafeInteger(value)
  },
  documentFormat: {
    type: String,
    default: null,
    lowercase: true,
    trim: true,
    maxlength: 10,
    enum: ["xlsx", "csv"]
  },
  status: {
    type: String,
    enum: [
      "submitted",
      "approved",
      "rejected",
      "revision_requested"
    ],
    default: "submitted",
    index: true
  },
  submittedAt: {
    type: Date,
    required: true
  },
  revisionCount: {
    type: Number,
    default: 0,
    min: 0,
    validate: Number.isSafeInteger
  },
  reviewHistory: {
    type: [reviewHistorySchema],
    default: []
  },
  reviewNote: {
    type: String,
    default: "",
    trim: true,
    maxlength: 2000
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  reviewedAt: {
    type: Date,
    default: null
  },
  rewardCents: {
    type: Number,
    required: true,
    min: 1,
    validate: Number.isSafeInteger,
    immutable: true
  },
  walletTransactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "DataEntryTransaction",
    default: null
  }
}, {
  timestamps: true,
  versionKey: false
});

schema.pre("validate", function validateSubmission() {
  const hasText = typeof this.submissionText === "string" &&
    this.submissionText.trim().length > 0;

  const hasLink = typeof this.submissionLink === "string" &&
    this.submissionLink.trim().length > 0;

  const hasDocument = typeof this.documentPublicId === "string" &&
    this.documentPublicId.length > 0;

  if (!hasText && !hasLink && !hasDocument) {
    this.invalidate(
      "submissionText",
      "Submit text, a valid HTTPS link or an uploaded document."
    );
  }
});

schema.index(
  { orderId: 1, userId: 1 },
  { unique: true, name: "one_submission_per_data_entry_order" }
);

schema.index({ userId: 1, submittedAt: -1 });
schema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.models.DataEntrySubmission ||
  mongoose.model("DataEntrySubmission", schema);
