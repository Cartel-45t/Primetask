const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60
    },

    lastName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60
    },

    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 30,
      match: /^[a-z0-9_]+$/
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254
    },

    phone: {
      type: String,
      required: true,
      trim: true,
      maxlength: 25
    },

    profilePictureUrl: {
      type: String,
      default: null,
      trim: true,
      maxlength: 2048
    },

    profilePicturePublicId: {
      type: String,
      default: null,
      select: false,
      maxlength: 255
    },

    selectedService: {
      type: String,
      enum: ["transcription", "note-taking", "data-entry", "academic-writing"],
      default: null
    },

    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },

    passwordHash: {
      type: String,
      required: true,
      select: false
    },

    role: {
      type: String,
      enum: ["user", "admin", "founder"],
      default: "user"
    },

    status: {
      type: String,
      enum: ["active", "suspended"],
      default: "active"
    },

    emailVerified: {
      type: Boolean,
      default: false
    },

    lastLoginAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);


module.exports = mongoose.model("User", userSchema);
