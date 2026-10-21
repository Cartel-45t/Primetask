"use strict";

const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { Readable } = require("node:stream");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const AUDIO_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  "audio/ogg",
  "audio/flac",
  "audio/webm"
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 7
  },
  fileFilter(req, file, callback) {
    if (!AUDIO_MIME_TYPES.has(file.mimetype)) {
      return callback(new Error("UNSUPPORTED_AUDIO_TYPE"));
    }
    callback(null, true);
  }
});

function cloudinaryReady() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

function detectAudioType(buffer) {
  if (!buffer || buffer.length < 12) return null;

  if (
    buffer.subarray(0, 3).toString("ascii") === "ID3" ||
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
  ) return "mp3";

  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  ) return "wav";

  if (buffer.toString("ascii", 4, 8) === "ftyp") return "mp4";

  if (buffer.toString("ascii", 0, 4) === "OggS") return "ogg";

  if (buffer.toString("ascii", 0, 4) === "fLaC") return "flac";

  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) return "webm";

  return null;
}

function uploadAudio(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "primetask-workspace/transcription/audio",
        resource_type: "video",
        type: "authenticated",
        use_filename: false,
        unique_filename: true,
        overwrite: false,
        allowed_formats: [
          "mp3", "wav", "m4a", "ogg", "flac", "webm"
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

router.post(
  "/audio",
  requireAuth,
  (req, res, next) => {
    if (!["admin", "founder"].includes(req.user.role)) {
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

    next();
  },
  (req, res, next) => {
    upload.single("audio")(req, res, error => {
      if (!error) return next();

      if (error instanceof multer.MulterError) {
        const message = error.code === "LIMIT_FILE_SIZE"
          ? "Audio must be 100 MB or smaller."
          : "Upload one audio file at a time.";

        return res.status(400).json({
          success: false,
          message
        });
      }

      return res.status(400).json({
        success: false,
        message: error.message === "UNSUPPORTED_AUDIO_TYPE"
          ? "Unsupported audio type. Upload MP3, WAV, M4A, OGG, FLAC, or WebM audio."
          : "Audio upload could not be processed."
      });
    });
  },
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Choose an audio file to upload."
      });
    }

    const detectedType = detectAudioType(req.file.buffer);

    const compatibleTypes = {
      "audio/mpeg": ["mp3"],
      "audio/mp3": ["mp3"],
      "audio/wav": ["wav"],
      "audio/x-wav": ["wav"],
      "audio/mp4": ["mp4"],
      "audio/x-m4a": ["mp4"],
      "audio/ogg": ["ogg"],
      "audio/flac": ["flac"],
      "audio/webm": ["webm"]
    };

    if (!detectedType || !compatibleTypes[req.file.mimetype]?.includes(detectedType)) {
      return res.status(400).json({
        success: false,
        message: "The file content does not match a supported audio format."
      });
    }

    try {
      const result = await uploadAudio(req.file.buffer);

      if (
        result.resource_type !== "video" ||
        result.type !== "authenticated" ||
        !result.public_id ||
        !result.public_id.startsWith("primetask-workspace/transcription/audio/")
      ) {
        if (result.public_id) {
          await cloudinary.uploader.destroy(result.public_id, {
            resource_type: "video",
            type: result.type || "authenticated",
            invalidate: true
          }).catch(() => {});
        }

        throw new Error("Cloudinary returned an unexpected asset configuration.");
      }

      return res.status(201).json({
        success: true,
        message: "Audio uploaded securely.",
        asset: {
          originalName: req.file.originalname,
          publicId: result.public_id,
          resourceType: result.resource_type,
          deliveryType: result.type,
          format: result.format,
          bytes: result.bytes,
          durationSeconds: result.duration || null
        }
      });
    } catch (error) {
      console.error("Transcription audio upload error:", error.message);

      return res.status(502).json({
        success: false,
        message: "Audio could not be stored. Check Cloudinary configuration and upload settings."
      });
    }
  }
);


/*
 * POST /api/admin/transcription/assets/audio/batch
 * Accepts 1–7 protected audio uploads. Each file is content-checked.
 */
router.post(
  "/audio/batch",
  requireAuth,
  (req, res, next) => {
    if (!["admin", "founder"].includes(req.user.role)) {
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

    next();
  },
  (req, res, next) => {
    upload.array("audio", 7)(req, res, error => {
      if (!error) return next();

      if (error instanceof multer.MulterError) {
        let message = "Batch upload could not be processed.";
        if (error.code === "LIMIT_FILE_SIZE") {
          message = "Each audio file must be 100 MB or smaller.";
        } else if (
          error.code === "LIMIT_FILE_COUNT" ||
          error.code === "LIMIT_UNEXPECTED_FILE"
        ) {
          message = "Upload between 1 and 7 audio files using the audio field.";
        }

        return res.status(400).json({ success: false, message });
      }

      return res.status(400).json({
        success: false,
        message: error.message === "UNSUPPORTED_AUDIO_TYPE"
          ? "Every file must be MP3, WAV, M4A, OGG, FLAC, or WebM audio."
          : "Batch upload could not be processed."
      });
    });
  },
  async (req, res) => {
    const files = req.files || [];

    if (!files.length || files.length > 7) {
      return res.status(400).json({
        success: false,
        message: "Choose between 1 and 7 audio files."
      });
    }

    const compatibleTypes = {
      "audio/mpeg": ["mp3"],
      "audio/mp3": ["mp3"],
      "audio/wav": ["wav"],
      "audio/x-wav": ["wav"],
      "audio/mp4": ["mp4"],
      "audio/x-m4a": ["mp4"],
      "audio/ogg": ["ogg"],
      "audio/flac": ["flac"],
      "audio/webm": ["webm"]
    };

    for (const file of files) {
      const detectedType = detectAudioType(file.buffer);
      if (
        !detectedType ||
        !compatibleTypes[file.mimetype]?.includes(detectedType)
      ) {
        return res.status(400).json({
          success: false,
          message: `File "${file.originalname}" does not match a supported audio format. No files in this batch were uploaded.`
        });
      }
    }

    const uploaded = [];

    try {
      for (const file of files) {
        const result = await uploadAudio(file.buffer);

        const validAsset =
          result &&
          result.resource_type === "video" &&
          result.type === "authenticated" &&
          typeof result.public_id === "string" &&
          result.public_id.startsWith(
            "primetask-workspace/transcription/audio/"
          );

        if (!validAsset) {
          if (result?.public_id) {
            await cloudinary.uploader.destroy(result.public_id, {
              resource_type: "video",
              type: result.type || "authenticated",
              invalidate: true
            }).catch(() => {});
          }
          throw new Error("Unexpected protected audio asset configuration.");
        }

        uploaded.push({
          originalName: file.originalname,
          publicId: result.public_id,
          resourceType: result.resource_type,
          deliveryType: result.type,
          format: result.format,
          bytes: result.bytes,
          durationSeconds: result.duration || null
        });
      }

      return res.status(201).json({
        success: true,
        message: `${uploaded.length} audio file(s) uploaded securely.`,
        assets: uploaded
      });
    } catch (error) {
      console.error("Transcription batch audio upload error:", error.message);

      // Avoid leaving partial batches in Cloudinary after a failed upload.
      await Promise.allSettled(
        uploaded.map(asset =>
          cloudinary.uploader.destroy(asset.publicId, {
            resource_type: "video",
            type: "authenticated",
            invalidate: true
          })
        )
      );

      return res.status(502).json({
        success: false,
        message: "The audio batch could not be stored. No jobs were created."
      });
    }
  }
);


module.exports = router;
