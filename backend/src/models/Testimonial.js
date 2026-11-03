"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    immutable: true
  },
  message: {
    type: String,
    required: true,
    trim: true,
    minlength: 20,
    maxlength: 1200
  },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
    required: true,
    index: true
  },
  featured: { type: Boolean, default: false },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  reviewedAt: { type: Date, default: null },
  adminNote: { type: String, trim: true, maxlength: 500, default: "" }
}, {
  timestamps: true,
  versionKey: false
});

schema.index(
  { userId: 1 },
  { unique: true, name: "unique_testimonial_per_user" }
);

schema.index({ status: 1, featured: -1, reviewedAt: -1 });

module.exports = mongoose.model("Testimonial", schema);
