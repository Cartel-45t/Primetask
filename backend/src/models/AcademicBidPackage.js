"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, default: "", trim: true, maxlength: 500 },
  bids: { type: Number, required: true, min: 1, max: 100000, validate: Number.isSafeInteger },
  priceKes: { type: Number, required: true, min: 1, max: 100000000, validate: Number.isSafeInteger },
  isActive: { type: Boolean, default: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true, versionKey: false });
schema.index({ isActive: 1, bids: 1 });

module.exports = mongoose.models.AcademicBidPackage || mongoose.model("AcademicBidPackage", schema);