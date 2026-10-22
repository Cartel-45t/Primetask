"use strict";

const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");
const cloudinary = require("cloudinary").v2;
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

const AUDIO_FOLDER = "primetask-workspace/transcription/audio";
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const ALLOWED_FORMATS = ["mp3", "wav", "m4a", "ogg", "flac", "webm"];

function cloudinaryReady() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

function configureCloudinary() {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

function adminOnly(req, res, next) {
  const audioDebug = req.path === "/audio/signature";
  if (audioDebug) {
    console.log("[audio-signature-debug] admin check entered", {
      role: req.user?.role,
      cloudinaryConfigured: cloudinaryReady()
    });
  }
  if (!["admin", "founder"].includes(req.user?.role)) {
    return res.status(403).json({
      success: false,
      message: "Administrator access required."
    });
  }

  if (!cloudinaryReady()) {
    return res.status(503).json({
      success: false,
      message: "Audio storage is not configured on the server."
    });
  }

  configureCloudinary();
  next();
}

function isExpectedPublicId(publicId) {
  return typeof publicId === "string" &&
    publicId.startsWith(AUDIO_FOLDER + "/") &&
    /^primetask-workspace\/transcription\/audio\/[A-Za-z0-9_-]+$/.test(publicId);
}

function safeOriginalName(value) {
  if (typeof value !== "string" || !value.trim()) return "audio";
  return path.basename(value.trim()).slice(0, 180);
}

/*
 * POST /api/admin/transcription/assets/audio/signature
 * Generates a signature for one specific protected Cloudinary asset.
 * The Cloudinary API secret never leaves this server.
 */
router.post("/audio/signature", requireAuth, adminOnly, (req, res) => {
  console.log("[audio-signature-debug] signature handler entered");
  const originalName = safeOriginalName(req.body?.originalName);
  const extension = path.extname(originalName).slice(1).toLowerCase();
  const size = Number(req.body?.size);

  if (!ALLOWED_FORMATS.includes(extension)) {
    return res.status(400).json({
      success: false,
      message: "Unsupported audio format. Use MP3, WAV, M4A, OGG, FLAC, or WebM."
    });
  }

  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_AUDIO_BYTES) {
    return res.status(400).json({
      success: false,
      message: "Audio must be larger than zero bytes and no more than 100 MB."
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
    console.log("[audio-signature-debug] signature generated successfully");

    return res.json({
      success: true,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      signature,
      params
    });
  } catch (error) {
    console.error("Cloudinary signing error:", error.message);
    return res.status(502).json({
      success: false,
      message: "Could not authorize the audio upload."
    });
  }
});

/*
 * POST /api/admin/transcription/assets/audio/verify
 * Never trust browser-supplied Cloudinary metadata. Fetch the asset
 * through Cloudinary's authenticated API before accepting it.
 */
router.post("/audio/verify", requireAuth, adminOnly, async (req, res) => {
  const publicId = req.body?.publicId;
  const originalName = safeOriginalName(req.body?.originalName);

  if (!isExpectedPublicId(publicId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid audio asset reference."
    });
  }

  try {
    const asset = await cloudinary.api.resource(publicId, {
      resource_type: "video",
      type: "authenticated",
      media_metadata: true,
    });

    const format = String(asset.format || "").toLowerCase();
    const bytes = Number(asset.bytes);
    console.error("[Cloudinary audio diagnostic]", {
      resourceType: asset.resource_type,
      deliveryType: asset.type,
      format: asset.format,
      bytes: asset.bytes,
      duration: asset.duration,
      audioDuration: asset.audio_duration,
      metadataKeys: Object.keys(asset).filter(key =>
        /duration|audio|format|resource_type|^type$|^bytes$|public_id/i.test(key)
      )
    });

    const durationSeconds = Number(asset.duration);

    if (
      asset.public_id !== publicId ||
      asset.resource_type !== "video" ||
      asset.type !== "authenticated" ||
      !ALLOWED_FORMATS.includes(format) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > MAX_AUDIO_BYTES
    ) {
      return res.status(422).json({
        success: false,
        message: "Cloudinary asset verification failed."
      });
    }

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return res.status(422).json({
        success: false,
        message: "Cloudinary did not return a verifiable audio duration."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Audio uploaded and verified securely.",
      asset: {
        originalName,
        publicId: asset.public_id,
        resourceType: asset.resource_type,
        deliveryType: asset.type,
        format,
        bytes,
        durationSeconds
      }
    });
  } catch (error) {
    const status = Number(error.http_code || error.statusCode);

    if (status === 404) {
      return res.status(404).json({
        success: false,
        message: "The uploaded Cloudinary asset was not found."
      });
    }

    console.error("Cloudinary audio verification error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Could not verify the uploaded audio with Cloudinary."
    });
  }
});

module.exports = router;
