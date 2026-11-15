"use strict";

const mongoose = require("mongoose");

const platformAnnouncementSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  message: { type: String, required: true, trim: true, maxlength: 5000 },
  status: { type: String, enum: ["published", "draft", "archived"], default: "published", index: true },
  startsAt: { type: Date, default: Date.now },
  endsAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
}, { timestamps: true, versionKey: false });

platformAnnouncementSchema.index({ status:  1, startsAt: 1, endsAt: 1, createdAt: -1 });

module.exports = mongoose.model("PlatformAnnouncement", platformAnnouncementSchema);