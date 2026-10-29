"use strict";

const mongoose = require("mongoose");
const { randomUUID } = require("crypto");

const schema = new mongoose.Schema({
  purchaseReference: {
    type: String,
    required: true,
    unique: true,
    immutable: true,
    default: () => `PTW-NP-${randomUUID()}`,
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
    ref: "NotesPointsPackage",
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
  points: {
    type: Number,
    required: true,
    min: 1,
    validate: Number.isSafeInteger,
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
  hasUnresolvedPayment: {
    type: Boolean,
    default: true,
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
    validate: value =>
      value === null ||
      (Number.isSafeInteger(value) && value > 0)
  },
  verificationMethod: {
    type: String,
    enum: ["provider_confirmation"],
    default: null
  },
  evidenceSource: {
    type: String,
    enum: ["daraja_provider_confirmation"],
    default: null
  },
  evidenceReference: {
    type: String,
    default: null,
    trim: true,
    maxlength: 150
  },
  verifiedAt: {
    type: Date,
    default: null
  },
  failureCode: {
    type: String,
    default: null,
    maxlength: 100
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
  {
    unique: true,
    name: "unique_notes_points_purchase_idempotency"
  }
);

schema.index(
  { checkoutRequestId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      checkoutRequestId: { $type: "string" }
    },
    name: "unique_notes_points_checkout"
  }
);

schema.index(
  { mpesaReceipt: 1 },
  {
    unique: true,
    partialFilterExpression: {
      mpesaReceipt: { $type: "string" }
    },
    name: "unique_notes_points_receipt"
  }
);

schema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { hasUnresolvedPayment: true },
    name: "unique_unresolved_notes_points_purchase_per_user"
  }
);

schema.index({ paymentStatus: 1, createdAt: 1 });

module.exports = mongoose.models.NotesPointsPurchase ||
  mongoose.model("NotesPointsPurchase", schema);
