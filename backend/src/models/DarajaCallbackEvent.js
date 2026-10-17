const mongoose = require("mongoose");

const darajaCallbackEventSchema = new mongoose.Schema(
  {
    eventKey: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      maxlength: 200
    },
    checkoutRequestId: {
      type: String,
      required: true,
      maxlength: 150,
      index: true
    },
    merchantRequestId: {
      type: String,
      default: null,
      maxlength: 150
    },
    resultCode: {
      type: Number,
      default: null
    },
    resultDescription: {
      type: String,
      default: "",
      maxlength: 500
    },
    // Untrusted callback metadata, stored for later reconciliation.
    // These fields must never independently authorize a wallet credit.
    callbackAmountKes: {
      type: Number,
      default: null,
      min: 1
    },
    callbackReceipt: {
      type: String,
      default: null,
      trim: true,
      uppercase: true,
      maxlength: 30
    },
    callbackPhoneNumber: {
      type: String,
      default: null,
      trim: true,
      maxlength: 20
    },
    transactionDate: {
      type: String,
      default: null,
      maxlength: 20
    },
    processingStatus: {
      type: String,
      enum: ["received", "reconciliation_required", "processed"],
      default: "received",
      required: true
    },
    receivedAt: {
      type: Date,
      default: Date.now,
      immutable: true
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

module.exports = mongoose.model(
  "DarajaCallbackEvent",
  darajaCallbackEventSchema
);
