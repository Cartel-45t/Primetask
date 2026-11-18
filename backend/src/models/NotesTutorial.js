"use strict";

const mongoose = require("mongoose");

const notesTutorialSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, default: "", maxlength: 2000 },
  category: { type: String, default: "General", trim: true, maxlength: 60 },
  publicId: { type: String, required: true, unique: true },
  secureUrl: { type: String, required: true },
  format: { type: String, required: true },
  bytes: { type: Number, required: true },
  durationSeconds: { type: Number, default: 0 },
  status: { type: String, enum: ["draft", "published"], default: "draft" },
  sortOrder: { type: Number, default: 0 },
  createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  publishedAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.models.NotesTutorial ||
  mongoose.model("NotesTutorial", notesTutorialSchema);
