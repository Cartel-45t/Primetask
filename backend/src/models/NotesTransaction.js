"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    immutable: true,
    index: true
  },
  walletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "NotesWallet",
    required: true,
    immutable: true
  },
  type: {
    type: String,
    enum: [
      "credit_purchase",
      "task_reservation",
      "task_debit",
      "reservation_release",
      "refund",
      "task_earning",
      "admin_adjustment"
    ],
    required: true,
    immutable: true
  },
  amountCents: {
    type: Number,
    required: true,
    validate: {
      validator: Number.isSafeInteger,
      message: "Transaction amounts must be whole USD cents."
    },
    immutable: true
  },
  reference: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    maxlength: 180,
    immutable: true
  },
  description: {
    type: String,
    default: "",
    trim: true,
    maxlength: 500,
    immutable: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: undefined,
    immutable: true
  }
}, {
  timestamps: true,
  versionKey: false
});

schema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.models.NotesTransaction ||
  mongoose.model("NotesTransaction", schema);
