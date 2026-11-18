"use strict";

const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");
const cloudinary = require("cloudinary").v2;

const requireAuth = require("../middleware/requireAuth");
const TranscriptionLesson = require("../models/TranscriptionLesson");

const router = express.Router();

const MATERIALS_FOLDER =
  "primetask-workspace/transcription/learning/materials";

const MAX_MATERIAL_BYTES = 10 * 1024 * 1024;
const VIDEO_FOLDER =
  "primetask-workspace/transcription/learning/videos";
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const MAX_VIDEO_DURATION_SECONDS = 7200;
const ALLOWED_VIDEO_FORMATS = ["mp4", "webm", "mov", "m4v"];

const ALLOWED_FORMATS = [
  "pdf",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "xls",
  "xlsx",
  "txt",
  "csv"
];

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
  if (!["admin", "founder"].includes(req.user?.role)) {
    return res.status(403).json({
      success: false,
      message: "Administrator access required."
    });
  }

  if (!cloudinaryReady()) {
    return res.status(503).json({
      success: false,
      message: "Learning Materials storage is not configured."
    });
  }

  configureCloudinary();
  next();
}

function safeOriginalName(value) {
  if (typeof value !== "string") return "";

  return path.basename(value.trim()).slice(0, 180);
}

function expectedPublicId(publicId) {
  return (
    typeof publicId === "string" &&
    /^primetask-workspace\/transcription\/learning\/materials\/[a-f0-9-]{36}\.(pdf|doc|docx|ppt|pptx|xls|xlsx|txt|csv)$/i.test(publicId)
  );
}

router.use(requireAuth);
router.use(adminOnly);

/*
 * POST /api/admin/transcription/learning/assets/signature
 * Authorizes one authenticated raw Learning Materials upload.
 */
router.post("/signature", async (req, res) => {
  const lessonId = req.body?.lessonId;
  const originalName = safeOriginalName(req.body?.originalName);
  const size = Number(req.body?.size);
  const title = typeof req.body?.title === "string"
    ? req.body.title.trim()
    : "";

  if (!lessonId || !/^[a-f0-9]{24}$/i.test(String(lessonId))) {
    return res.status(400).json({
      success: false,
      message: "A valid lesson reference is required."
    });
  }

  if (!title || title.length > 180) {
    return res.status(400).json({
      success: false,
      message: "Material title is required and must not exceed 180 characters."
    });
  }

  const extension = path.extname(originalName).slice(1).toLowerCase();

  if (!ALLOWED_FORMATS.includes(extension)) {
    return res.status(400).json({
      success: false,
      message: "Unsupported file type. Use PDF, DOC, DOCX, PPT, PPTX, XLS, XLSX, TXT or CSV."
    });
  }

  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_MATERIAL_BYTES
  ) {
    return res.status(400).json({
      success: false,
      message: "Learning Materials must be larger than zero bytes and no larger than 10 MB."
    });
  }

  try {
    const lesson = await TranscriptionLesson.findById(lessonId)
      .select("_id");

    if (!lesson) {
      return res.status(404).json({
        success: false,
        message: "Lesson not found."
      });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const publicId =
      `${MATERIALS_FOLDER}/${crypto.randomUUID()}.${extension}`;

    const params = {
      timestamp,
      public_id: publicId,
      type: "authenticated",
      overwrite: false,
      allowed_formats: ALLOWED_FORMATS.join(","),
      context:
        `ptw_admin_id=${String(req.user._id)}` +
        `|ptw_lesson_id=${String(lesson._id)}` +
        `|ptw_material_title=${title.replace(/[|=]/g, " ")}`
    };

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
    console.error("Learning Materials signature error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Could not authorize the Learning Materials upload."
    });
  }
});

/*
 * POST /api/admin/transcription/learning/assets/verify
 * Verifies the uploaded Cloudinary asset before attaching it to a lesson.
 */
router.post("/verify", async (req, res) => {
  const lessonId = req.body?.lessonId;
  const publicId = req.body?.publicId;
  const originalName = safeOriginalName(req.body?.originalName);
  const title = typeof req.body?.title === "string"
    ? req.body.title.trim()
    : "";

  if (
    !lessonId ||
    !/^[a-f0-9]{24}$/i.test(String(lessonId)) ||
    !expectedPublicId(publicId) ||
    !title ||
    title.length > 180
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid Learning Materials verification details."
    });
  }

  const extension = path.extname(originalName).slice(1).toLowerCase();
  const publicExtension = path.extname(publicId).slice(1).toLowerCase();

  if (
    !ALLOWED_FORMATS.includes(extension) ||
    extension !== publicExtension
  ) {
    return res.status(400).json({
      success: false,
      message: "The uploaded file extension does not match the selected file."
    });
  }

  try {
    const lesson = await TranscriptionLesson.findById(lessonId);

    if (!lesson) {
      return res.status(404).json({
        success: false,
        message: "Lesson not found."
      });
    }

    const asset = await cloudinary.api.resource(publicId, {
      resource_type: "raw",
      type: "authenticated"
    });

    const bytes = Number(asset.bytes);
    const custom = asset.context?.custom || {};

    if (
      asset.public_id !== publicId ||
      asset.resource_type !== "raw" ||
      asset.type !== "authenticated" ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > MAX_MATERIAL_BYTES ||
      String(custom.ptw_admin_id || "") !== String(req.user._id) ||
      String(custom.ptw_lesson_id || "") !== String(lesson._id) ||
      String(custom.ptw_material_title || "") !== title
    ) {
      return res.status(422).json({
        success: false,
        message: "Cloudinary Learning Materials verification failed."
      });
    }

    const verifiedFormat = String(
      asset.format || publicExtension
    ).toLowerCase();

    if (verifiedFormat !== extension) {
      return res.status(422).json({
        success: false,
        message: "The verified file format does not match the selected file."
      });
    }

    const duplicate = lesson.documents.some(
      item => item.publicId === asset.public_id
    );

    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: "This Learning Material is already attached to the lesson."
      });
    }

    lesson.documents.push({
      title,
      publicId: asset.public_id,
      resourceType: "raw",
      format: verifiedFormat,
      bytes
    });

    lesson.updatedBy = req.user._id;
    await lesson.save();

    return res.status(200).json({
      success: true,
      message: "Learning Material uploaded, verified and attached.",
      material: lesson.documents[lesson.documents.length - 1]
    });
  } catch (error) {
    const status = Number(error.http_code || error.statusCode);

    if (status === 404) {
      return res.status(404).json({
        success: false,
        message: "The uploaded Learning Material was not found."
      });
    }

    console.error("Learning Materials verification error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Could not verify the uploaded Learning Material."
    });
  }
});


/*
 * POST /api/admin/transcription/learning/assets/video/signature
 * Authorizes one authenticated Learning Centre video upload.
 */
router.post("/video/signature", async (req, res) => {
  const lessonId = req.body?.lessonId;
  const originalName = safeOriginalName(req.body?.originalName);
  const size = Number(req.body?.size);
  const extension = path.extname(originalName).slice(1).toLowerCase();

  if (!lessonId || !/^[a-f0-9]{24}$/i.test(String(lessonId))) {
    return res.status(400).json({
      success: false,
      message: "A valid lesson reference is required."
    });
  }

  if (!ALLOWED_VIDEO_FORMATS.includes(extension)) {
    return res.status(400).json({
      success: false,
      message: "Use MP4, WebM, MOV or M4V video files."
    });
  }

  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_VIDEO_BYTES
  ) {
    return res.status(400).json({
      success: false,
      message: "Video must be larger than zero bytes and no larger than 500 MB."
    });
  }

  try {
    const lesson = await TranscriptionLesson.findById(lessonId)
      .select("_id");

    if (!lesson) {
      return res.status(404).json({
        success: false,
        message: "Lesson not found."
      });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const publicId = `${VIDEO_FOLDER}/${crypto.randomUUID()}`;

    const params = {
      timestamp,
      public_id: publicId,
      type: "authenticated",
      overwrite: false,
      allowed_formats: ALLOWED_VIDEO_FORMATS.join(","),
      context:
        `ptw_admin_id=${String(req.user._id)}` +
        `|ptw_lesson_id=${String(lesson._id)}`
    };

    const signature = cloudinary.utils.api_sign_request(
      params,
      process.env.CLOUDINARY_API_SECRET
    );

    return res.json({
      success: true,
      resourceType: "video",
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      signature,
      params
    });
  } catch (error) {
    console.error("Learning video signature error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Could not authorize the video upload."
    });
  }
});

/*
 * POST /api/admin/transcription/learning/assets/video/verify
 * Verifies the actual authenticated Cloudinary video before attachment.
 */
router.post("/video/verify", async (req, res) => {
  const lessonId = req.body?.lessonId;
  const publicId = req.body?.publicId;

  if (
    !lessonId ||
    !/^[a-f0-9]{24}$/i.test(String(lessonId)) ||
    typeof publicId !== "string" ||
    !/^primetask-workspace\/transcription\/learning\/videos\/[a-f0-9-]{36}$/i.test(publicId)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid video verification details."
    });
  }

  try {
    const lesson = await TranscriptionLesson.findById(lessonId);

    if (!lesson) {
      return res.status(404).json({
        success: false,
        message: "Lesson not found."
      });
    }

    const asset = await cloudinary.api.resource(publicId, {
      resource_type: "video",
      type: "authenticated",
      media_metadata: true
    });

    const bytes = Number(asset.bytes);
    const durationSeconds = Number(asset.duration);
    const format = String(asset.format || "").toLowerCase();
    const custom = asset.context?.custom || {};

    if (
      asset.public_id !== publicId ||
      asset.resource_type !== "video" ||
      asset.type !== "authenticated" ||
      !ALLOWED_VIDEO_FORMATS.includes(format) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > MAX_VIDEO_BYTES ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > MAX_VIDEO_DURATION_SECONDS ||
      String(custom.ptw_admin_id || "") !== String(req.user._id) ||
      String(custom.ptw_lesson_id || "") !== String(lesson._id)
    ) {
      return res.status(422).json({
        success: false,
        message: "Cloudinary video verification failed."
      });
    }

    lesson.videoType = "uploaded";
    lesson.video = {
      publicId: asset.public_id,
      resourceType: "video",
      format,
      bytes,
      durationSeconds
    };
    lesson.externalVideoUrl = null;
    lesson.updatedBy = req.user._id;

    await lesson.save();

    return res.status(200).json({
      success: true,
      message: "Video uploaded, verified and attached to the lesson.",
      video: {
        publicId: asset.public_id,
        resourceType: "video",
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
        message: "The uploaded video was not found."
      });
    }

    console.error("Learning video verification error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Could not verify the uploaded video."
    });
  }
});

module.exports = router;
