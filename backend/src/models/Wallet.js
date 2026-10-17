const mongoose = require("mongoose");

const walletSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true
    },

    currency: {
      type: String,
      enum: ["USD"],
      default: "USD",
      immutable: true
    },

    availableBalanceCents: {
      type: Number,
      min: 0,
      default: 0,
      required: true
    },

    pendingEarningsCents: {
      type: Number,
      min: 0,
      default: 0,
      required: true
    },

    totalEarningsCents: {
      type: Number,
      min: 0,
      default: 0,
      required: true
    },

    totalWithdrawalsCents: {
      type: Number,
      min: 0,
      default: 0,
      required: true
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

module.exports = mongoose.model("Wallet", walletSchema);
