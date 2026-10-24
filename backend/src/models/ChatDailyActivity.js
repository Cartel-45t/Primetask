"use strict";

const mongoose = require("mongoose");

const chatDailyActivitySchema = new mongoose.Schema({
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ChatConversation",
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  dayKey: {
    type: String,
    required: true,
    match: /^\d{4}-\d{2}-\d{2}$/
  },
  messageCount: {
    type: Number,
    min: 0,
    default: 0,
    required: true
  },
  firstMessageAt: {
    type: Date,
    default: null
  },
  lastMessageAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true,
  versionKey: false
});

chatDailyActivitySchema.index(
  { conversationId: 1, dayKey: 1, userId: 1 },
  { unique: true, name: "unique_chat_daily_user_activity" }
);

module.exports = mongoose.model("ChatDailyActivity", chatDailyActivitySchema);
