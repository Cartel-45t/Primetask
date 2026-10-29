"use strict";

const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");
const cloudinary = require("cloudinary").v2;
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

const AUDIO_FOLDER = "primetask-workspace/note-taking/audio";
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const ALLOWED_FORMATS = ["mp3", "wav", "m4a", "ogg", "flac", "webm"];

function ready() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

function adminOnly(req, res, next) {
  if (!["admin", "founder"].includes(req.user?.role)) {
    return res.status(403).json({
      success: false,
      message: "Administrator access required."
    });
  }

  if (!ready()) {
    return res.status(503).json({
      success: false,
      message: "Notes audio storage is not configured."
    });
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  next();
}

function safeName(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  return path.basename(value.trim()).slice(0, 180);
}

router.use(requireAuth);
router.use(adminOnly);

router.post("/audio/signature", (req, res) => {
  const originalName = safeName(req.body?.originalName);
  const extension = path.extname(originalName).slice(1).toLowerCase();
  const size = Number(req.body?.size);

  if (!ALLOWED_FORMATS.includes(extension)) {
    return res.status(400).json({
      success: false,
      message: "Use MP3, WAV, M4A, OGG, FLAC, or WebM audio."
    });
  }

  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_AUDIO_BYTES) {
    return res.status(400).json({
      success: false,
      message: "Audio must be between 1 byte and 100 MB."
    });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `${AUDIO_FOLDER}/${crypto.randomUUID()}`;
  const params = {
    timestamp,
    public_id: publicId,
    type: "authenticated",
    overwrite: false,
    allowed_formats: ALLOWED_FORMATS.join(",")
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
    console.error("Notes audio signing error:", error.message);
    return res.status(502).json({
      success: false,
      message: "Could not authorize the Notes audio upload."
    });
  }
});

router.post("/audio/verify", async (req, res) => {
  const publicId = req.body?.publicId;
  const originalName = safeName(req.body?.originalName);

  if (
    typeof publicId !== "string" ||
    !/^primetask-workspace\/note-taking\/audio\/[A-Za-z0-9_-]+$/.test(publicId)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid Notes audio asset reference."
    });
  }

  try {
    const asset = await cloudinary.api.resource(publicId, {
      resource_type: "video",
      type: "authenticated",
      media_metadata: true
    });

    const format = String(asset.format || "").toLowerCase();
    const bytes = Number(asset.bytes);
    const durationSeconds = Number(asset.duration);

    if (
      asset.public_id !== publicId ||
      asset.resource_type !== "video" ||
      asset.type !== "authenticated" ||
      !ALLOWED_FORMATS.includes(format) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > MAX_AUDIO_BYTES ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > 1440 * 60
    ) {
      return res.status(422).json({
        success: false,
        message: "Cloudinary could not verify this Notes audio file."
      });
    }

    return res.json({
      success: true,
      asset: {
        publicId: asset.public_id,
        originalName: originalName || "audio",
        format,
        bytes,
        durationSeconds,
        durationMinutes: Math.ceil(durationSeconds / 60)
      }
    });
  } catch (error) {
    if (Number(error.http_code || error.statusCode) === 404) {
      return res.status(404).json({
        success: false,
        message: "The uploaded Notes audio was not found."
      });
    }

    console.error("Notes audio verification error:", error.message);
    return res.status(502).json({
      success: false,
      message: "Could not verify the Notes audio with Cloudinary."
    });
  }
});

module.exports = router;
