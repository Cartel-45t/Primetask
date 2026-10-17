"use strict";

const mongoose = require("mongoose");

const rangeSchema = new mongoose.Schema({
  minMinutes: { type: Number, required: true, min: 1, max: 10000 },
  maxMinutes: { type: Number, required: true, min: 1, max: 10000 },
  rewardUsd: { type: Number, required: true, min: 1, max: 1000000 }
}, { _id: true });

const schema = new mongoose.Schema({
  key: { type: String, default: "transcription", unique: true, immutable: true },
  defaultAudioTitle: {
    type: String,
    default: "Transcription Task",
    trim: true,
    maxlength: 180,
    required: true
  },
  durationRewardRanges: {
    type: [rangeSchema],
    default: [{ minMinutes: 1, maxMinutes: 5, rewardUsd: 1 }]
  },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
}, { timestamps: true, versionKey: false });

module.exports = mongoose.models.TranscriptionSettings ||
  mongoose.model("TranscriptionSettings", schema);
