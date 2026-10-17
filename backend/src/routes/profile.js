"use strict";

const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { Readable } = require("stream");
const User = require("../models/User");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const PROFILE_FIELDS =
  "firstName lastName username email phone role status emailVerified " +
  "selectedService profilePictureUrl referredBy createdAt updatedAt";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error("Choose a JPEG, PNG, or WebP image."));
    }
    cb(null, true);
  }
});

function cloudinaryReady() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

function imageSignature(buffer) {
  if (!buffer || buffer.length < 12) return null;

  const jpeg =
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff;

  const png =
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );

  const webp =
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP";

  if (jpeg) return "image/jpeg";
  if (png) return "image/png";
  if (webp) return "image/webp";
  return null;
}

function publicProfile(user) {
  return {
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    emailVerified: user.emailVerified,
    selectedService: user.selectedService || null,
    profilePictureUrl: user.profilePictureUrl || null,
    sponsor: user.referredBy
      ? {
          username: user.referredBy.username,
          firstName: user.referredBy.firstName,
          lastName: user.referredBy.lastName
        }
      : null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "primetask-workspace/profiles",
        resource_type: "image",
        allowed_formats: ["jpg", "png", "webp"],
        transformation: [
          { width: 512, height: 512, crop: "fill", gravity: "face" },
          { quality: "auto", fetch_format: "auto" }
        ]
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    Readable.from(buffer).pipe(stream);
  });
}

async function deleteCloudinaryImage(publicId) {
  if (!publicId || !cloudinaryReady()) return;

  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: "image",
      invalidate: true
    });
  } catch (error) {
    // A failed cloud cleanup must not undo a successful profile update.
    console.error("Cloudinary cleanup failed:", error.message);
  }
}

function handleUploadError(error, req, res, next) {
  if (!error) return next();

  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "Image must be 3 MB or smaller."
      : "Upload one image at a time.";
    return res.status(400).json({ success: false, message });
  }

  if (error.message === "Choose a JPEG, PNG, or WebP image.") {
    return res.status(400).json({ success: false, message: error.message });
  }

  return res.status(400).json({
    success: false,
    message: "Unable to process the uploaded image."
  });
}

// GET /api/profile
router.get("/", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select(PROFILE_FIELDS)
      .populate({ path: "referredBy", select: "username firstName lastName" })
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Member account not found."
      });
    }

    return res.json({ success: true, user: publicProfile(user) });
  } catch (error) {
    console.error("Profile load error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load your profile."
    });
  }
});

// POST /api/profile/picture
router.post(
  "/picture",
  requireAuth,
  (req, res, next) => {
    if (!cloudinaryReady()) {
      return res.status(503).json({
        success: false,
        message: "Profile-picture storage is not configured on the server."
      });
    }
    next();
  },
  upload.single("picture"),
  handleUploadError,
  async (req, res) => {
    let uploaded;

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Choose an image to upload."
        });
      }

      const actualType = imageSignature(req.file.buffer);
      if (!actualType || actualType !== req.file.mimetype) {
        return res.status(400).json({
          success: false,
          message: "The file content does not match a supported image type."
        });
      }

      uploaded = await uploadToCloudinary(req.file.buffer);

      const user = await User.findById(req.user._id)
        .select("+profilePicturePublicId");

      if (!user) {
        await deleteCloudinaryImage(uploaded.public_id);
        return res.status(404).json({
          success: false,
          message: "Member account not found."
        });
      }

      const oldPublicId = user.profilePicturePublicId;

      user.profilePictureUrl = uploaded.secure_url;
      user.profilePicturePublicId = uploaded.public_id;
      await user.save();

      await deleteCloudinaryImage(oldPublicId);

      return res.json({
        success: true,
        message: "Profile picture updated.",
        profilePictureUrl: user.profilePictureUrl
      });
    } catch (error) {
      if (uploaded && uploaded.public_id) {
        await deleteCloudinaryImage(uploaded.public_id);
      }
      console.error("Profile-picture upload error:", error.message);
      return res.status(500).json({
        success: false,
        message: "Unable to save your profile picture."
      });
    }
  }
);

// DELETE /api/profile/picture
router.delete("/picture", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select("+profilePicturePublicId");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Member account not found."
      });
    }

    const oldPublicId = user.profilePicturePublicId;
    user.profilePictureUrl = null;
    user.profilePicturePublicId = null;
    await user.save();

    await deleteCloudinaryImage(oldPublicId);

    return res.json({
      success: true,
      message: "Profile picture removed."
    });
  } catch (error) {
    console.error("Profile-picture removal error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to remove your profile picture."
    });
  }
});

// PATCH /api/profile
router.patch("/", requireAuth, async (req, res) => {
  try {
    const allowed = ["firstName", "lastName", "phone"];
    const submitted = Object.keys(req.body || {});

    if (!submitted.length || submitted.some((key) => !allowed.includes(key))) {
      return res.status(400).json({
        success: false,
        message: "Only first name, last name and phone number can be updated here."
      });
    }

    const updates = {};

    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(req.body, key)) continue;

      if (typeof req.body[key] !== "string") {
        return res.status(400).json({
          success: false,
          message: "Profile fields must be text."
        });
      }

      const value = req.body[key].trim();
      if (!value) {
        return res.status(400).json({
          success: false,
          message: `${key} cannot be empty.`
        });
      }

      const max = key === "phone" ? 25 : 60;
      if (value.length > max) {
        return res.status(400).json({
          success: false,
          message: `${key} is too long.`
        });
      }

      if (key === "phone" && value.length < 7) {
        return res.status(400).json({
          success: false,
          message: "Enter a valid phone number."
        });
      }

      updates[key] = value;
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true, runValidators: true }
    )
      .select(PROFILE_FIELDS)
      .populate({ path: "referredBy", select: "username firstName lastName" })
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Member account not found."
      });
    }

    return res.json({
      success: true,
      message: "Profile updated.",
      user: publicProfile(user)
    });
  } catch (error) {
    console.error("Profile update error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to update your profile."
    });
  }
});

module.exports = router;
