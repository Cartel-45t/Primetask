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
    enum: ["approved", "rejected"],
    required: true
  }
}, { _id: false });

const transcriptionSubmissionSchema = new mongoose.Schema({
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "TranscriptionJob",
    required: true,
    immutable: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    immutable: true
  },
  transcriptText: {
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
      message: "Submission link must be a valid HTTPS URL without embedded credentials."
    }
  },
  documentPublicId: {
    type: String,
    default: null,
    maxlength: 500
  },
  documentOriginalName: {
    type: String,
    default: "",
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
    enum: ["docx", null],
    default: null
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
  status: {
    type: String,
    enum: ["submitted", "approved", "rejected"],
    default: "submitted",
    index: true
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
    ref: "TranscriptionWalletTransaction",
    default: null
  }
}, { timestamps: true, versionKey: false });

transcriptionSubmissionSchema.pre("validate", function validateSubmission() {
  const hasText = typeof this.transcriptText === "string" &&
    this.transcriptText.trim().length > 0;

  const hasDocument = typeof this.documentPublicId === "string" &&
    /^primetask-workspace\/transcription\/documents\/[A-Za-z0-9_./-]+$/.test(
      this.documentPublicId
    ) &&
    !this.documentPublicId.includes("..");

  if (this.submissionLink) {
    try {
      const parsed = new URL(this.submissionLink);
      if (
        parsed.protocol !== "https:" ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password
      ) {
        this.invalidate(
          "submissionLink",
          "Submission link must be a valid HTTPS URL without embedded credentials."
        );
      }
    } catch {
      this.invalidate(
        "submissionLink",
        "Submission link must be a valid HTTPS URL."
      );
    }
  }

  if (!hasText && !hasDocument) {
    this.invalidate(
      "transcriptText",
      "Provide transcript text or a validated DOCX document."
    );
  }

  if (this.documentPublicId && this.documentFormat !== "docx") {
    this.invalidate("documentFormat", "Document format must be DOCX.");
  }

});

transcriptionSubmissionSchema.index(
  { jobId: 1, userId: 1 },
  { unique: true, name: "one_submission_per_transcription_job" }
);

transcriptionSubmissionSchema.index({ userId: 1, createdAt: -1 });
transcriptionSubmissionSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.models.TranscriptionSubmission ||
  mongoose.model("TranscriptionSubmission", transcriptionSubmissionSchema);
