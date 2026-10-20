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
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 13
    },
    status: {
      type: String,
      enum: ["pending_review", "approved", "paid", "rejected"],
      default: "pending_review",
      index: true
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
