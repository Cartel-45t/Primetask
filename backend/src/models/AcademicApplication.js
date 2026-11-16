"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  jobId: { type: mongoose.Schema.Types.ObjectId, ref: "AcademicJob", required: true, immutable: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true, index: true },
  proposedPriceCents: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  deliveryDays: { type: Number, required: true, min: 1, max: 3650, validate: Number.isSafeInteger },
  coverLetter: { type: String, required: true, trim: true, minlength: 50, maxlength: 5000 },
  qualifications: { type: String, required: true, trim: true, minlength: 10, maxlength: 4000 },
  experience: { type: String, required: true, trim: true, minlength: 10, maxlength: 4000 },
  skills: { type: [String], required: true, validate: v => v.length > 0 && v.length <= 30 },
  workApproach: { type: String, required: true, trim: true, minlength: 20, maxlength: 5000 },
  portfolio: { type: [String], default: [], validate: v => v.length <= 10 },
  availabilityConfirmed: { type: Boolean, required: true, validate: v => v === true },
  requirementsAccepted: { type: Boolean, required: true, validate: v => v === true },
  bidCost: { type: Number, required: true, min: 1, validate: Number.isSafeInteger, immutable: true },
  status: { type: String, enum: ["submitted", "under_review", "shortlisted", "awarded", "unsuccessful", "withdrawn"], default: "submitted", index: true },
  submittedAt: { type: Date, required: true, default: Date.now, immutable: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reviewedAt: { type: Date, default: null },
  reviewNote: { type: String, default: "", trim: true, maxlength: 2000 }
}, { timestamps: true, versionKey: false });

schema.index({ jobId:  1, userId: 1 }, { unique: true, name: "unique_academic_application_per_member_job" });
schema.index({ status: 1, submittedAt: -1 });

module.exports = mongoose.models.AcademicApplication || mongoose.model("AcademicApplication", schema);