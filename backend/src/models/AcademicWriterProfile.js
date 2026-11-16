"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true,
    immutable: true,
    index: true
  },
  headline: {
    type: String,
    default: "",
    trim: true,
    maxlength: 120
  },
  bio: {
    type: String,
    default: "",
    trim: true,
    maxlength: 2000
  },
  qualifications: {
    type: String,
    default: "",
    trim: true,
    maxlength: 4000
  },
  experience: {
    type: String,
    default: "",
    trim: true,
    maxlength: 4000
  },
  skills: {
    type: [String],
    default: [],
    validate: v => v.length <= 30 && v.every(x => typeof x === "string" && x.trim().length > 0 && x.length <= 80)
  },
  specializations: {
    type: [String],
    default: [],
    validate: v => v.length <= 20 && v.every(x => typeof x === "string" && x.trim().length > 0 && x.length <= 100)
  },
  portfolio: {
    type: [String],
    default: [],
    validate: v => v.length <= 10 && v.every(x => typeof x === "string" && x.length <= 500)
  }
}, {
  timestamps: true,
  versionKey: false
});

module.exports = mongoose.models.AcademicWriterProfile ||
  mongoose.model("AcademicWriterProfile", schema);
