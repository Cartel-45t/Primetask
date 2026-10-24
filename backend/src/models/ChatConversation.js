"use strict";

const mongoose = require("mongoose");

const chatConversationSchema = new mongoose.Schema({
  kind: {
    type: String,
    enum: ["member", "admin"],
    required: true
  },
  participantIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  }],
  conversationKey: {
    type: String,
    required: true,
    unique: true,
    immutable: true,
    maxlength: 100
  },
  lastMessageAt: {
    type: Date,
    default: null
  },
  lastMessageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ChatMessage",
    default: null
  },
  active: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true,
  versionKey: false
});

chatConversationSchema.index({ participantIds: 1, lastMessageAt: -1 });

module.exports = mongoose.model("ChatConversation", chatConversationSchema);
