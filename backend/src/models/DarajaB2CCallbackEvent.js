const mongoose = require("mongoose");

const darajaB2CCallbackEventSchema = new mongoose.Schema(
  {
    eventKey: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      maxlength: 200
    },
    callbackType: {
      type: String,
      enum: ["result", "timeout"],
      required: true,
      immutable: true
    },
    originatorConversationId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      index: true
    },
    conversationId: {
      type: String,
      default: null,
      trim: true,
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
    transactionId: {
      type: String,
      default: null,
      trim: true,
      uppercase: true,
      maxlength: 30
    },
    transactionAmountKes: {
      type: Number,
      default: null,
      validate: {
        validator: value =>
          value === null ||
          value === undefined ||
          (Number.isSafeInteger(value) && value > 0),
        message: "Transaction amount must be a positive whole KSh amount."
      }
    },
    receiverPartyPublicName: {
      type: String,
      default: null,
      trim: true,
      maxlength: 200
    },
    transactionCompletedDateTime: {
      type: String,
      default: null,
      maxlength: 30
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

darajaB2CCallbackEventSchema.index(
  { originatorConversationId: 1, receivedAt: -1 },
  { name: "b2c_callback_originator_received" }
);

module.exports = mongoose.model(
  "DarajaB2CCallbackEvent",
  darajaB2CCallbackEventSchema
);
