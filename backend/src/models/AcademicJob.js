"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 180 },
  description: { type: String, required: true, trim: true, maxlength: 12000 },
  discipline: { type: String, required: true, trim: true, maxlength: 100 },
  subject: { type: String, required: true, trim: true, maxlength: 100 },
  academicLevel: { type: String, required: true, trim: true, maxlength: 80 },
  serviceCategory: { type: String, required: true, trim: true, maxlength: 80 },
  skills: { type: [String], default: [], validate: v => v.length <= 30 },
  qualifications: { type: [String], default: [], validate: v => v.length <= 30 },
  scope: { type: String, default: "", trim: true, maxlength: 5000 },
  wordCount: { type: Number, default: null, min: 1, validate: v => v == null || Number.isSafeInteger(v) },
  referencingStyle: { type: String, default: "", trim: true, maxlength: 80 },
  deliverables: { type: [String], default: [], validate: v => v.length <= 30 },
  budgetMinCents: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  budgetMaxCents: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  requiredBids: { type: Number, required: true, min: 1, max: 1000, validate: Number.isSafeInteger },
  applicationClosesAt: { type: Date, required: true },
  deadline: { type: Date, required: true },
  successfulApplicants: { type: Number, default: 1, min: 1, max: 50, validate: Number.isSafeInteger },
  awardedCount: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  instructions: { type: String, default: "", trim: true, maxlength: 5000 },
  status: { type: String, enum: ["draft", "published", "paused", "closed", "archived"], default: "draft", index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  publishedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });

schema.pre("validate", function validateJob() {
  if (this.budgetMaxCents < this.budgetMinCents) this.invalidate("budgetMaxCents", "Maximum budget must be at least the minimum.");
  if (this.deadline <= this.applicationClosesAt) this.invalidate("deadline", "Project deadline must be after the application closing date.");
});
schema.index({ status: 1, applicationClosesAt: 1, createdAt: -1 });
schema.index({ discipline: 1, subject: 1, academicLevel: 1, status: 1 });
schema.index({ title: "text", description: "text", discipline: "text", subject: "text" });

module.exports = mongoose.models.AcademicJob || mongoose.model("AcademicJob", schema);