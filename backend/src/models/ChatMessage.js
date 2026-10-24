"use strict";

const mongoose = require("mongoose");

const chatMessageSchema = new mongoose.Schema({
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ChatConversation",
    required: true,
    index: true
  },
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  text: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 4000
  },
  messageType: {
    type: String,
    enum: ["text"],
    default: "text",
    immutable: true
  }
}, {
  timestamps: true,
  versionKey: false
});

chatMessageSchema.index({ conversationId: 1, createdAt: -1 });

module.exports = mongoose.model("ChatMessage", chatMessageSchema);
