"use strict";

const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema({
  recipientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: [
      "chat_message",
      "chat_streak_unlocked",
      "chat_streak_reward"
    ],
    required: true
  },
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ChatConversation",
    default: null
  },
  messageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ChatMessage",
    default: null
  },
  readAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true,
  versionKey: false
});

notificationSchema.index({ recipientId: 1, createdAt: -1 });
notificationSchema.index({ recipientId: 1, readAt: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
