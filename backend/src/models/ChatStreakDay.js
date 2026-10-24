"use strict";

const mongoose = require("mongoose");

const chatStreakDaySchema = new mongoose.Schema({
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ChatConversation",
    required: true
  },
  dayKey: {
    type: String,
    required: true,
    match: /^\d{4}-\d{2}-\d{2}$/
  },
  participantIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  }],
  qualifiedAt: {
    type: Date,
    required: true,
    default: Date.now
  },
  streakDayNumber: {
    type: Number,
    min: 1,
    required: true
  },
  rewardCentsPerParticipant: {
    type: Number,
    min: 0,
    required: true,
    default: 0,
    validate: Number.isSafeInteger
  },
  unlockedNow: {
    type: Boolean,
    default: false,
    required: true
  }
}, {
  timestamps: true,
  versionKey: false
});

chatStreakDaySchema.index(
  { conversationId: 1, dayKey: 1 },
  { unique: true, name: "unique_chat_streak_day" }
);

module.exports = mongoose.model("ChatStreakDay", chatStreakDaySchema);
