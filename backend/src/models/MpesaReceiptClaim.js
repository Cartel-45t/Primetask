const mongoose = require("mongoose");

const mpesaReceiptClaimSchema = new mongoose.Schema(
  {
    receipt: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 6,
      maxlength: 30,
      match: /^[A-Z0-9]{6,30}$/,
      immutable: true
    },
    purpose: {
      type: String,
      required: true,
      enum: [
        "membership_purchase",
        "deposit",
        "withdrawal",
        "transcription_minute_purchase"
      ],
      immutable: true
    },
    referenceId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
      immutable: true
    },
    amountKes: {
      type: Number,
      min: 1,
      validate: {
        validator: value =>
          value === undefined || Number.isSafeInteger(value),
        message: "KSh amount must be a whole number."
      },
      immutable: true
    },
    claimedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      immutable: true
    },
    evidenceSource: {
      type: String,
      required: true,
      enum: [
        "safaricom_portal",
        "safaricom_statement",
        "deposit_completion_service",
        "admin_manual_payout",
        "daraja_provider_confirmation"
      ],
      immutable: true
    },
    evidenceReference: {
      type: String,
      trim: true,
      maxlength: 150,
      immutable: true
    },
    claimedAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

// The central cross-platform uniqueness constraint.
mpesaReceiptClaimSchema.index(
  { receipt: 1 },
  {
    unique: true,
    name: "unique_global_mpesa_receipt"
  }
);

mpesaReceiptClaimSchema.index(
  { purpose: 1, referenceId: 1 },
  { name: "mpesa_receipt_claim_reference" }
);

module.exports = mongoose.model(
  "MpesaReceiptClaim",
  mpesaReceiptClaimSchema
);
