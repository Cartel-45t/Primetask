"use strict";

const mongoose = require("mongoose");
const { randomUUID } = require("crypto");

const schema = new mongoose.Schema({
  purchaseReference: {
    type: String,
    required: true,
    unique: true,
    immutable: true,
    default: () => `PTW-TM-${randomUUID()}`,
    maxlength: 80
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    immutable: true,
    index: true
  },
  idempotencyKey: {
    type: String,
    required: true,
    trim: true,
    minlength: 8,
    maxlength: 150,
    immutable: true
  },
  packageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "TranscriptionMinutePackage",
    required: true,
    immutable: true
  },
  packageName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120,
    immutable: true
  },
  minutes: {
    type: Number,
    required: true,
    min: 1,
    validate: Number.isSafeInteger,
    immutable: true
  },
  priceCents: {
    type: Number,
    required: true,
    min: 100,
    validate: {
      validator: value =>
        Number.isSafeInteger(value) && value % 100 === 0,
      message: "Package price must be a whole USD amount."
    },
    immutable: true
  },
  currency: {
    type: String,
    enum: ["USD"],
    default: "USD",
    required: true,
    immutable: true
  },
  expectedAmountKes: {
    type: Number,
    required: true,
    min: 1,
    validate: Number.isSafeInteger,
    immutable: true
  },
  phoneNumber: {
    type: String,
    required: true,
    trim: true,
    match: /^254[17]\d{8}$/,
    immutable: true
  },
  paymentStatus: {
    type: String,
    enum: [
      "pending",
      "verification_required",
      "verified",
      "failed",
      "cancelled"
    ],
    default: "pending",
    required: true,
    index: true
  },
  // True while this user has a payment awaiting a confirmed outcome.
  // A unique partial index below enforces one unresolved purchase per user.
  hasUnresolvedPayment: {
    type: Boolean,
    default: false,
    required: true
  },
  merchantRequestId: {
    type: String,
    default: null,
    maxlength: 150
  },
  checkoutRequestId: {
    type: String,
    default: null,
    maxlength: 150
  },
  mpesaReceipt: {
    type: String,
    default: null,
    trim: true,
    uppercase: true,
    maxlength: 30
  },
  verifiedAmountKes: {
    type: Number,
    default: null,
    min: 1,
    validate: {
      validator: value =>
        value === null || Number.isSafeInteger(value),
      message: "Verified KSh amount must be a whole number."
    }
  },
  verificationMethod: {
    type: String,
    enum: ["admin_manual_reconciliation"],
    default: null
  },
  evidenceSource: {
    type: String,
    enum: ["safaricom_portal", "safaricom_statement"],
    default: null
  },
  evidenceReference: {
    type: String,
    default: null,
    trim: true,
    maxlength: 150
  },
  verifiedByAdminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  verifiedAt: {
    type: Date,
    default: null
  },
  failureCode: {
    type: String,
    default: null,
    maxlength: 80
  },
  failureDescription: {
    type: String,
    default: "",
    maxlength: 500
  },
  lastReconciledAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true,
  versionKey: false
});

schema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true, name: "unique_transcription_minute_purchase_idempotency" }
);

schema.index(
  { checkoutRequestId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      checkoutRequestId: { $type: "string" }
    },
    name: "unique_transcription_minute_checkout"
  }
);

schema.index(
  { mpesaReceipt: 1 },
  {
    unique: true,
    partialFilterExpression: {
      mpesaReceipt: { $type: "string" }
    },
    name: "unique_transcription_minute_receipt"
  }
);

schema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { hasUnresolvedPayment: true },
    name: "unique_unresolved_transcription_minute_purchase_per_user"
  }
);

schema.index({ paymentStatus: 1, createdAt: 1 });

module.exports = mongoose.models.TranscriptionMinutePurchase ||
  mongoose.model("TranscriptionMinutePurchase", schema);
