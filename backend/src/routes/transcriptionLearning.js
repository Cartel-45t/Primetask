"use strict";

const express = require("express");
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2;

const requireAuth = require("../middleware/requireAuth");
const requireServiceAccess = require("../middleware/requireServiceAccess");
const TranscriptionLesson = require("../models/TranscriptionLesson");

const router = express.Router();

const MATERIALS_FOLDER =
  "primetask-workspace/transcription/learning/materials";

const MAX_MATERIAL_BYTES = 10 * 1024 * 1024;

const ALLOWED_FORMATS = [
  "pdf", "doc", "docx", "ppt", "pptx",
  "xls", "xlsx", "txt", "csv"
];

router.use(requireAuth);
router.use(requireServiceAccess("transcription"));

function configureCloudinary() {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

function cloudinaryReady() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

function publicLesson(lesson) {
  return {
    id: String(lesson._id),
    title: lesson.title,
    description: lesson.description,
    content: lesson.content,
    category: lesson.category,
    videoType: lesson.videoType,
    externalVideoUrl: lesson.videoType === "external"
      ? lesson.externalVideoUrl
      : null,
    hasVideo: lesson.videoType !== "none",
    documents: (lesson.documents || []).map(document => ({
      id: String(document._id),
      title: document.title,
      format: document.format
    })),
    createdAt: lesson.createdAt,
    updatedAt: lesson.updatedAt
  };
}

/*
 * GET /api/transcription/learning
 * Published lessons only.
 */
router.get("/", async (req, res) => {
  try {
    const lessons = await TranscriptionLesson.find({
      published: true
    })
      .select(
        "title description content category videoType externalVideoUrl documents createdAt updatedAt displayOrder"
      )
      .sort({ displayOrder: 1, createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      lessons: lessons.map(publicLesson)
    });
  } catch (error) {
    console.error("Transcription learning library error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not load the Learning Centre."
    });
  }
});

/*
 * GET /api/transcription/learning/:id
 * Individual published lesson.
 */
router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid lesson reference."
      });
    }

    const lesson = await TranscriptionLesson.findOne({
      _id: req.params.id,
      published: true
    }).lean();

    if (!lesson) {
      return res.status(404).json({
        success: false,
        message: "This lesson is unavailable."
      });
    }

    return res.json({
      success: true,
      lesson: publicLesson(lesson)
    });
  } catch (error) {
    console.error("Transcription lesson error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not load this lesson."
    });
  }
});

/*
 * GET /api/transcription/learning/:id/materials/:materialId/download
 * Re-verifies a published lesson material and issues a short-lived URL.
 */
router.get("/:id/materials/:materialId/download", async (req, res) => {
  try {
    const { id, materialId } = req.params;

    if (
      !mongoose.isValidObjectId(id) ||
      !mongoose.isValidObjectId(materialId)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid lesson or Learning Material reference."
      });
    }

    if (!cloudinaryReady()) {
      return res.status(503).json({
        success: false,
        message: "Learning Materials storage is unavailable."
      });
    }

    const lesson = await TranscriptionLesson.findOne({
      _id: id,
      published: true
    });

    if (!lesson) {
      return res.status(404).json({
        success: false,
        message: "This lesson is unavailable."
      });
    }

    const material = lesson.documents.id(materialId);

    if (!material) {
      return res.status(404).json({
        success: false,
        message: "Learning Material not found."
      });
    }

    const publicId = material.publicId;
    const format = String(material.format || "").toLowerCase();

    if (
      material.resourceType !== "raw" ||
      !ALLOWED_FORMATS.includes(format) ||
      typeof publicId !== "string" ||
      !publicId.startsWith(`${MATERIALS_FOLDER}/`) ||
      !new RegExp(
        `^primetask-workspace/transcription/learning/materials/[a-f0-9-]{36}\\.${format}$`,
        "i"
      ).test(publicId)
    ) {
      return res.status(422).json({
        success: false,
        message: "Learning Material reference failed security validation."
      });
    }

    configureCloudinary();

    const asset = await cloudinary.api.resource(publicId, {
      resource_type: "raw",
      type: "authenticated"
    });

    const bytes = Number(asset.bytes);

    if (
      asset.public_id !== publicId ||
      asset.resource_type !== "raw" ||
      asset.type !== "authenticated" ||
      String(asset.format || "").toLowerCase() !== format ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > MAX_MATERIAL_BYTES ||
      bytes !== Number(material.bytes)
    ) {
      return res.status(422).json({
        success: false,
        message: "Learning Material could not be verified."
      });
    }

    const downloadUrl = cloudinary.utils.private_download_url(
      publicId,
      format,
      {
        resource_type: "raw",
        type: "authenticated",
        expires_at: Math.floor(Date.now() / 1000) + 120
      }
    );

    const parsedUrl = new URL(downloadUrl);

    if (
      parsedUrl.protocol !== "https:" ||
      !["api.cloudinary.com", "res.cloudinary.com"].includes(
        parsedUrl.hostname
      )
    ) {
      throw new Error("Unexpected Cloudinary download URL.");
    }

    res.set("Cache-Control", "no-store");

    return res.json({
      success: true,
      title: material.title,
      format,
      downloadUrl
    });
  } catch (error) {
    const status = Number(error.http_code || error.statusCode);

    if (status === 404) {
      return res.status(404).json({
        success: false,
        message: "Learning Material is no longer available."
      });
    }

    console.error("Learning Material download error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Could not prepare the Learning Material download."
    });
  }
});


/*
 * GET /api/transcription/learning/:id/video/playback
 * Protected playback URL for an uploaded lesson video.
 */
router.get("/:id/video/playback", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid lesson reference."
      });
    }

    if (!cloudinaryReady()) {
      return res.status(503).json({
        success: false,
        message: "Video storage is unavailable."
      });
    }

    const lesson = await TranscriptionLesson.findOne({
      _id: req.params.id,
      published: true,
      videoType: "uploaded"
    }).select("video");

    if (!lesson?.video?.publicId) {
      return res.status(404).json({
        success: false,
        message: "Uploaded lesson video not found."
      });
    }

    const video = lesson.video;
    const publicId = video.publicId;
    const format = String(video.format || "").toLowerCase();

    if (
      video.resourceType !== "video" ||
      !["mp4", "webm", "mov", "m4v"].includes(format) ||
      typeof publicId !== "string" ||
      !/^primetask-workspace\/transcription\/learning\/videos\/[a-f0-9-]{36}$/i.test(publicId)
    ) {
      return res.status(422).json({
        success: false,
        message: "Video reference failed security validation."
      });
    }

    configureCloudinary();

    const asset = await cloudinary.api.resource(publicId, {
      resource_type: "video",
      type: "authenticated"
    });

    if (
      asset.public_id !== publicId ||
      asset.resource_type !== "video" ||
      asset.type !== "authenticated" ||
      String(asset.format || "").toLowerCase() !== format ||
      Number(asset.bytes) !== Number(video.bytes) ||
      Number(asset.duration) !== Number(video.durationSeconds)
    ) {
      return res.status(422).json({
        success: false,
        message: "The lesson video could not be verified."
      });
    }

    const playbackUrl = cloudinary.utils.private_download_url(
      publicId,
      format,
      {
        resource_type: "video",
        type: "authenticated",
        expires_at: Math.floor(Date.now() / 1000) + 120
      }
    );

    const parsedUrl = new URL(playbackUrl);

    if (
      parsedUrl.protocol !== "https:" ||
      !["api.cloudinary.com", "res.cloudinary.com"].includes(
        parsedUrl.hostname
      )
    ) {
      throw new Error("Unexpected Cloudinary playback URL.");
    }

    res.set("Cache-Control", "no-store");

    return res.json({
      success: true,
      playbackUrl,
      expiresInSeconds: 120,
      durationSeconds: video.durationSeconds
    });
  } catch (error) {
    const status = Number(error.http_code || error.statusCode);

    if (status === 404) {
      return res.status(404).json({
        success: false,
        message: "The lesson video is no longer available."
      });
    }

    console.error("Learning video playback error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Could not prepare lesson video playback."
    });
  }
});

module.exports = router;
