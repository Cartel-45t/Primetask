"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  walletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "NotesPointsWallet",
    required: true
  },
  type: {
    type: String,
    enum: ["purchase_credit", "task_claim"],
    required: true
  },
  points: {
    type: Number,
    required: true,
    validate: {
      validator: value =>
        Number.isSafeInteger(value) && value !== 0,
      message: "Points must be a non-zero whole number."
    }
  },
  reference: {
    type: String,
    required: true,
    unique: true,
    immutable: true,
    maxlength: 150
  },
  purchaseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "NotesPointsPurchase",
    default: null
  },
  description: {
    type: String,
    required: true,
    maxlength: 300
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true,
  versionKey: false
});

schema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.models.NotesPointsTransaction ||
  mongoose.model("NotesPointsTransaction", schema);
