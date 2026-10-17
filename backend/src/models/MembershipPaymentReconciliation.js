const mongoose = require("mongoose");

const membershipPaymentReconciliationSchema = new mongoose.Schema(
  {
    purchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MembershipPurchase",
      required: true,
      immutable: true,
      index: true
    },
    purchaseReference: {
      type: String,
      required: true,
      immutable: true,
      trim: true
    },
    checkoutRequestId: {
      type: String,
      required: true,
      immutable: true,
      trim: true
    },
    mpesaReceipt: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 30
    },
    amountKes: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "The verified KSh amount must be a whole number."
      }
    },
    evidenceSource: {
      type: String,
      required: true,
      enum: [
        "safaricom_portal",
        "safaricom_statement"
        ]
    },
    evidenceReference: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150
    },
    adminNote: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: ""
    },
    outcome: {
      type: String,
      required: true,
      enum: ["verified"],
      default: "verified",
      immutable: true
    },
    adminUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true
    },
    verifiedAt: {
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

// Prevent reuse of a receipt across successful reconciliation records.
membershipPaymentReconciliationSchema.index(
  { mpesaReceipt: 1 },
  {
    unique: true,
    name: "unique_reconciled_membership_receipt"
  }
);

membershipPaymentReconciliationSchema.index({
  purchaseId: 1,
  verifiedAt: -1
});

module.exports = mongoose.model(
  "MembershipPaymentReconciliation",
  membershipPaymentReconciliationSchema
);
