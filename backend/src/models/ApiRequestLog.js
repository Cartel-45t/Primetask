"use strict";

const mongoose = require("mongoose");

const apiRequestLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  username: {
    type: String,
    maxlength: 80,
    default: null
  },
  role: {
    type: String,
    maxlength: 30,
    default: "anonymous"
  },
  ipAddress: {
    type: String,
    maxlength: 100,
    default: null
  },
  method: {
    type: String,
    required: true,
    maxlength: 10
  },
  path: {
    type: String,
    required: true,
    maxlength: 500
  },
  statusCode: {
    type: Number,
    required: true
  },
  responseTimeMs: {
    type: Number,
    required: true,
    min: 0
  },
  userAgent: {
    type: String,
    maxlength: 500,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  versionKey: false,
  collection: "api_request_logs"
});

apiRequestLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 30 }
);

apiRequestLogSchema.index({ path: 1, createdAt: -1 });
apiRequestLogSchema.index({ userId: 1, createdAt: -1 });
apiRequestLogSchema.index({ ipAddress: 1, createdAt: -1 });
apiRequestLogSchema.index({ statusCode: 1, createdAt: -1 });

module.exports = mongoose.model("ApiRequestLog", apiRequestLogSchema);
