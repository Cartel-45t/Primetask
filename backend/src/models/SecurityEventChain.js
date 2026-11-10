"use strict";

const mongoose = require("mongoose");

const GENESIS_HASH = "0".repeat(64);

const securityEventChainSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "security-events"
    },

    sequence: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },

    lastHash: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/,
      default: GENESIS_HASH
    }
  },
  {
    timestamps: true,
    versionKey: false,
    strict: "throw"
  }
);

module.exports = mongoose.model(
  "SecurityEventChain",
  securityEventChainSchema
);
