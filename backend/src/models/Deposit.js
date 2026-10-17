const mongoose = require("mongoose");

const depositSchema = new mongoose.Schema(
  {
    requestId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      trim: true,
      maxlength: 100
    },

    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true
    },

    amountCents: {
      type: Number,
      required: true,
      min: 10,
      validate: {
        validator(value) {
          return Number.isSafeInteger(value) && value % 10 === 0;
        },
        message:
          "Deposit cents must be a safe integer in multiples of 10."
      }
    },

    currency: {
      type: String,
      enum: ["USD"],
      default: "USD",
      immutable: true,
      required: true
    },

    expectedAmountKes: {
      type: Number,
      required: true,
      min: 13,
      validate: {
        validator(value) {
          return Number.isSafeInteger(value);
        },
        message: "Expected KSh amount must be a whole number."
      }
    },

    phoneNumber: {
      type: String,
      required: true,
      trim: true,
      match: /^254[17]\d{8}$/
    },

    status: {
      type: String,
      enum: ["pending", "completed", "failed", "cancelled"],
      default: "pending",
      required: true
    },

    merchantRequestId: {
      type: String,
      default: null,
      trim: true,
      maxlength: 150
    },

    checkoutRequestId: {
      type: String,
      default: null,
      trim: true,
      maxlength: 150
    },

    mpesaReceipt: {
      type: String,
      default: null,
      trim: true,
      uppercase: true,
      maxlength: 30
    },

    resultCode: {
      type: Number,
      default: null
    },

    resultDescription: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500
    },

    walletTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WalletTransaction",
      default: null
    },

    completedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

depositSchema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true, name: "unique_user_deposit_idempotency" }
);

depositSchema.index(
  { userId: 1, createdAt: -1, _id: -1 },
  { name: "user_deposit_history" }
);

depositSchema.index(
  { checkoutRequestId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      checkoutRequestId: { $type: "string" }
    },
    name: "unique_daraja_checkout_request"
  }
);

depositSchema.index(
  { mpesaReceipt: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: "completed",
      mpesaReceipt: { $type: "string" }
    },
    name: "unique_completed_mpesa_receipt"
  }
);

module.exports = mongoose.model("Deposit", depositSchema);
