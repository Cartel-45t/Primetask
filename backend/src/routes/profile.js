"use strict";

const express = require("express");
const crypto = require("node:crypto");
const cloudinary = require("cloudinary").v2;
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

function cloudinaryReady() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
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

/*
 * POST /api/profile/picture/signature
 * Authorizes one image upload for the authenticated member.
 * The Cloudinary API secret never leaves this server.
 */
router.post("/picture/signature", requireAuth, (req, res) => {
  if (!cloudinaryReady()) {
    return res.status(503).json({
      success: false,
      message: "Profile-picture storage is not configured on the server."
    });
  }

  const size = Number(req.body?.size);
  const originalName = typeof req.body?.originalName === "string"
    ? req.body.originalName
    : "";
  const mimeType = typeof req.body?.type === "string"
    ? req.body.type.toLowerCase()
    : "";

  const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);

  if (!Number.isSafeInteger(size) || size < 1 || size > 3 * 1024 * 1024) {
    return res.status(400).json({
      success: false,
      message: "Image must be larger than zero bytes and no more than 3 MB."
    });
  }

  if (
    !allowed.has(mimeType) ||
    !/\.(jpe?g|png|webp)$/i.test(originalName)
  ) {
    return res.status(400).json({
      success: false,
      message: "Choose a JPEG, PNG, or WebP image."
    });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId =
    `primetask-workspace/profiles/${String(req.user._id)}_${crypto.randomUUID()}`;

  const params = {
    timestamp,
    public_id: publicId,
    overwrite: false,
    allowed_formats: "jpg,png,webp"
  };

  try {
    const signature = cloudinary.utils.api_sign_request(
      params,
      process.env.CLOUDINARY_API_SECRET
    );

    return res.json({
      success: true,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      signature,
      params
    });
  } catch (error) {
    console.error("Profile picture signing error:", error.message);
    return res.status(502).json({
      success: false,
      message: "Could not authorize the image upload."
    });
  }
});

/*
 * POST /api/profile/picture/complete
 * Verify the asset through Cloudinary before changing the member profile.
 */
router.post("/picture/complete", requireAuth, async (req, res) => {
  const publicId = req.body?.publicId;
  const userId = String(req.user._id);
  const expectedPrefix = `primetask-workspace/profiles/${userId}_`;

  if (
    typeof publicId !== "string" ||
    !publicId.startsWith(expectedPrefix) ||
    !new RegExp(
      "^primetask-workspace/profiles/" +
      userId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "_[0-9a-f-]{36}$",
      "i"
    ).test(publicId)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid profile-picture asset reference."
    });
  }

  if (!cloudinaryReady()) {
    return res.status(503).json({
      success: false,
      message: "Profile-picture storage is not configured on the server."
    });
  }

  let accepted = false;

  try {
    const asset = await cloudinary.api.resource(publicId, {
      resource_type: "image",
      type: "upload"
    });

    const formats = new Set(["jpg", "jpeg", "png", "webp"]);
    const bytes = Number(asset.bytes);

    if (
      asset.public_id !== publicId ||
      asset.resource_type !== "image" ||
      asset.type !== "upload" ||
      !formats.has(String(asset.format || "").toLowerCase()) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > 3 * 1024 * 1024 ||
      typeof asset.secure_url !== "string" ||
      !asset.secure_url.startsWith(
        `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`
      )
    ) {
      return res.status(422).json({
        success: false,
        message: "Cloudinary image verification failed."
      });
    }

    const user = await User.findById(userId).select("+profilePicturePublicId");

    if (!user) {
      await deleteCloudinaryImage(publicId);
      return res.status(404).json({
        success: false,
        message: "Member account not found."
      });
    }

    const oldPublicId = user.profilePicturePublicId;
    user.profilePictureUrl = asset.secure_url;
    user.profilePicturePublicId = asset.public_id;
    await user.save();
    accepted = true;

    await deleteCloudinaryImage(oldPublicId);

    return res.json({
      success: true,
      message: "Profile picture updated.",
      profilePictureUrl: user.profilePictureUrl
    });
  } catch (error) {
    console.error("Profile-picture verification error:", error.message);
    return res.status(502).json({
      success: false,
      message: "Unable to verify and save your profile picture."
    });
  } finally {
    // If verification failed, remove the unaccepted upload.
    if (!accepted) {
      await deleteCloudinaryImage(publicId);
    }
  }
});

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
      { returnDocument: "after", runValidators: true }
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
