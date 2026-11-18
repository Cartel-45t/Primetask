"use strict";

const mongoose = require("mongoose");

const learningDocumentSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 180
  },
  publicId: {
    type: String,
    required: true,
    trim: true
  },
  resourceType: {
    type: String,
    enum: ["raw"],
    default: "raw"
  },
  format: {
    type: String,
    required: true,
    lowercase: true
  },
  bytes: {
    type: Number,
    required: true,
    min: 1
  }
}, { _id: true });

const lessonSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 180
  },
  description: {
    type: String,
    required: true,
    trim: true,
    maxlength: 1000
  },
  content: {
    type: String,
    default: "",
    maxlength: 20000
  },
  category: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  videoType: {
    type: String,
    enum: ["uploaded", "external", "none"],
    default: "none"
  },
  video: {
    publicId: { type: String, default: null },
    resourceType: { type: String, default: null },
    format: { type: String, default: null },
    bytes: { type: Number, default: null },
    durationSeconds: { type: Number, default: null }
  },
  externalVideoUrl: {
    type: String,
    default: null,
    trim: true,
    maxlength: 1000
  },
  documents: {
    type: [learningDocumentSchema],
    default: []
  },
  published: {
    type: Boolean,
    default: false
  },
  displayOrder: {
    type: Number,
    default: 0,
    min: 0,
    max: 100000
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  }
}, {
  timestamps: true,
  versionKey: false
});

lessonSchema.index({ published: 1, displayOrder: 1, createdAt: -1 });

module.exports = mongoose.models.TranscriptionLesson ||
  mongoose.model("TranscriptionLesson", lessonSchema);
