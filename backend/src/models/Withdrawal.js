const mongoose = require("mongoose");

const withdrawalSchema = new mongoose.Schema(
  {
    requestId: {
      type: String,
      required: true,
      unique: true,
      immutable: true
    },
    publicReference: {
      type: String,
      immutable: true,
      match: /^PTW-WC[A-Z0-9]{8}$/,
      maxlength: 15
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    amountCents: {
      type: Number,
      required: true,
      min: 100,
      validate: Number.isSafeInteger
    },
    currency: {
      type: String,
      enum: ["USD"],
      default: "USD",
      immutable: true
    },
    exchangeRateKesPerUsd: {
      type: Number,
      min: 1,
      max: 1000,
      immutable: true,
      default: null
    },
    payoutAmountKes: {
      type: Number,
      min: 1,
      validate: {
        validator: value =>
          value === null ||
          value === undefined ||
          Number.isSafeInteger(value),
        message: "Payout amount must be a whole KSh amount."
      },
      immutable: true,
      default: null
    },
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 13
    },
    status: {
      type: String,
      enum: [
        "pending_review",
        "approved",
        "processing",
        "reconciliation_required",
        "paid",
        "rejected"
      ],
      default: "pending_review",
      index: true
    },
    b2cOriginatorConversationId: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null
    },
    b2cConversationId: {
      type: String,
      trim: true,
      maxlength: 150,
      default: null
    },
    b2cInitiationState: {
      type: String,
      enum: [
        "not_started",
        "submitting",
        "accepted",
        "unknown",
        "rejected",
        "succeeded"
      ],
      default: "not_started"
    },
    b2cInitiatedAt: {
      type: Date,
      default: null
    },
    b2cResultCode: {
      type: Number,
      default: null
    },
    b2cResultDescription: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null
    },
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WalletTransaction",
      default: null
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    reviewedAt: {
      type: Date,
      default: null
    },
    mpesaReceipt: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null
    },
    adminNote: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

withdrawalSchema.index({ userId: 1, createdAt: -1 });

withdrawalSchema.index(
  { b2cOriginatorConversationId: 1 },
  {
    unique: true,
    name: "unique_withdrawal_b2c_originator_id",
    partialFilterExpression: {
      b2cOriginatorConversationId: { $type: "string" }
    }
  }
);

withdrawalSchema.index(
  { publicReference: 1 },
  {
    unique: true,
    partialFilterExpression: {
      publicReference: { $type: "string" }
    }
  }
);

withdrawalSchema.index(
  { mpesaReceipt: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: "paid",
      mpesaReceipt: { $type: "string" }
    }
  }
);

module.exports = mongoose.model("Withdrawal", withdrawalSchema);
