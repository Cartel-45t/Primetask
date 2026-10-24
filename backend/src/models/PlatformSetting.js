"use strict";
const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: "platform", immutable: true },
  registrationEnabled: { type: Boolean, default: true, required: true },
  maintenanceMode: { type: Boolean, default: false, required: true },
  exchangeRateKesPerUsd: {
    type: Number,
    default: null,
    min: 1,
    max: 1000
  },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model("PlatformSetting", schema);
