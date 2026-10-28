"use strict";

const mongoose = require("mongoose");

const notesSubmissionSchema = new mongoose.Schema({
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "NotesTask",
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
  taskTitle: {
    type: String,
    required: true,
    immutable: true,
    maxlength: 180
  },
  notesText: {
    type: String,
    required: true,
    maxlength: 200000
  },
  status: {
    type: String,
    enum: ["submitted", "approved", "rejected"],
    default: "submitted",
    index: true
  },
  submittedAt: {
    type: Date,
    required: true,
    immutable: true
  },
  reviewedAt: {
    type: Date,
    default: null
  },
  reviewedByAdminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  reviewNotes: {
    type: String,
    default: "",
    maxlength: 5000
  }
}, {
  timestamps: true,
  versionKey: false
});

// One submission per member per task. Duplicate requests cannot create
// multiple submission records for the same assignment.
notesSubmissionSchema.index(
  { taskId: 1, userId: 1 },
  { unique: true }
);

notesSubmissionSchema.index({ userId: 1, submittedAt: -1 });

module.exports = mongoose.models.NotesSubmission ||
  mongoose.model("NotesSubmission", notesSubmissionSchema);
