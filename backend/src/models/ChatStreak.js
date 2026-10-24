"use strict";

const mongoose = require("mongoose");

const chatStreakSchema = new mongoose.Schema({
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ChatConversation",
    required: true,
    unique: true
  },
  currentStreakDays: {
    type: Number,
    min: 0,
    default: 0,
    required: true
  },
  longestStreakDays: {
    type: Number,
    min: 0,
    default: 0,
    required: true
  },
  lastQualifiedDayKey: {
    type: String,
    default: null
  },
  unlockedAt: {
    type: Date,
    default: null
  },
  rewardsActive: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true,
  versionKey: false
});

module.exports = mongoose.model("ChatStreak", chatStreakSchema);
