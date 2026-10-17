"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120
  },
  minutes: {
    type: Number,
    required: true,
    min: 1,
    max: 10000000,
    validate: {
      validator: Number.isSafeInteger,
      message: "Package minutes must be a whole number."
    }
  },
  priceCents: {
    type: Number,
    required: true,
    min: 100,
    validate: {
      validator(value) {
        return Number.isSafeInteger(value) && value % 100 === 0;
      },
      message: "Package price must be a whole USD amount."
    }
  },
  priceKes: {
    type: Number,
    required: true,
    min: 1,
    validate: {
      validator: Number.isSafeInteger,
      message: "M-Pesa package price must be a positive whole KSh amount."
    }
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  createdByAdminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  }
}, {
  timestamps: true,
  versionKey: false
});

schema.index({ isActive: 1, minutes: 1 });

module.exports = mongoose.models.TranscriptionMinutePackage ||
  mongoose.model("TranscriptionMinutePackage", schema);
