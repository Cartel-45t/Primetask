"use strict";

const mongoose = require("mongoose");

const notesTaskSchema = new mongoose.Schema({
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
    default: "General",
    trim: true,
    maxlength: 100
  },
  expectedNotes: {
    type: String,
    default: "",
    trim: true,
    maxlength: 5000
  },
  brief: {
    type: String,
    default: "",
    trim: true,
    maxlength: 10000
  },
  deliverables: {
    type: [String],
    default: [],
    validate: {
      validator: items =>
        items.length <= 30 &&
        items.every(item =>
          typeof item === "string" &&
          item.trim().length > 0 &&
          item.length <= 500
        ),
      message: "Deliverables must contain up to 30 non-empty strings."
    }
  },
  audioPublicId: {
    type: String,
    default: "",
    trim: true,
    maxlength: 300
  },
  audioOriginalName: {
    type: String,
    default: "",
    trim: true,
    maxlength: 180
  },
  audioFormat: {
    type: String,
    default: "",
    enum: ["", "mp3", "wav", "m4a", "ogg", "flac", "webm"]
  },
  audioBytes: {
    type: Number,
    default: 0,
    min: 0,
    validate: Number.isSafeInteger
  },
  audioDurationSeconds: {
    type: Number,
    default: 0,
    min: 0,
    validate: Number.isFinite
  },
  durationMinutes: {
    type: Number,
    required: true,
    min: 1,
    validate: Number.isSafeInteger
  },
  rewardCents: {
    type: Number,
    required: true,
    min: 1,
    validate: Number.isSafeInteger
  },
  taskCostCents: {
    type: Number,
    required: true,
    min: 1,
    validate: Number.isSafeInteger
  },
  status: {
    type: String,
    enum: ["draft", "available", "assigned", "submitted", "completed", "archived"],
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

notesTaskSchema.index({ status: 1, createdAt: -1 });
notesTaskSchema.index({ assignedUserId: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.models.NotesTask ||
  mongoose.model("NotesTask", notesTaskSchema);
