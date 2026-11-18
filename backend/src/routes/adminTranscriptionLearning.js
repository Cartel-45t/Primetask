"use strict";

const express = require("express");
const mongoose = require("mongoose");
const requireAuth = require("../middleware/requireAuth");
const TranscriptionLesson = require("../models/TranscriptionLesson");

const router = express.Router();

router.use(requireAuth);

router.use((req, res, next) => {
  if (!["admin", "founder"].includes(req.user?.role)) {
    return res.status(403).json({
      success: false,
      message: "Administrator access required."
    });
  }
  next();
});

function validExternalVideoUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;

  try {
    const url = new URL(value.trim());

    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      Boolean(url.hostname);
  } catch {
    return false;
  }
}

function validateLesson(body, partial = false) {
  const errors = [];
  const data = {};

  const fields = ["title", "description", "content", "category"];

  for (const field of fields) {
    if (partial && !Object.hasOwn(body, field)) continue;

    const value = body[field];

    if (typeof value !== "string") {
      errors.push(`${field} must be text.`);
      continue;
    }

    const clean = value.trim();

    if (field === "title" && (!clean || clean.length > 180)) {
      errors.push("Title is required and must not exceed 180 characters.");
    } else if (field === "description" && (!clean || clean.length > 1000)) {
      errors.push("Description is required and must not exceed 1000 characters.");
    } else if (field === "category" && (!clean || clean.length > 100)) {
      errors.push("Category is required and must not exceed 100 characters.");
    } else if (field === "content" && clean.length > 20000) {
      errors.push("Lesson content must not exceed 20000 characters.");
    } else {
      data[field] = clean;
    }
  }

  if (!partial || Object.hasOwn(body, "videoType")) {
    if (!["none", "external", "uploaded"].includes(body.videoType)) {
      errors.push("Invalid video type.");
    } else {
      data.videoType = body.videoType;
    }
  }

  if (!partial || Object.hasOwn(body, "externalVideoUrl")) {
    const url = body.externalVideoUrl;

    if (body.videoType === "external" || (partial && url)) {
      if (!validExternalVideoUrl(url)) {
        errors.push("External video URLs must be valid HTTPS links.");
      } else {
        data.externalVideoUrl = url.trim();
      }
    } else if (url === null || url === "") {
      data.externalVideoUrl = null;
    } else if (url !== undefined && url !== null) {
      errors.push("An external video URL is only allowed for external videos.");
    }
  }

  if (Object.hasOwn(body, "displayOrder")) {
    const order = Number(body.displayOrder);

    if (!Number.isSafeInteger(order) || order < 0 || order > 100000) {
      errors.push("Display order must be a whole number from 0 to 100000.");
    } else {
      data.displayOrder = order;
    }
  }

  if (Object.hasOwn(body, "published")) {
    if (typeof body.published !== "boolean") {
      errors.push("Published must be true or false.");
    } else {
      data.published = body.published;
    }
  }

  if (Object.hasOwn(body, "documents") || Object.hasOwn(body, "video")) {
    errors.push("Video and document assets must be added through the secure upload process.");
  }

  if (data.videoType === "external") {
    data.externalVideoUrl ??= body.externalVideoUrl?.trim();
  } else if (data.videoType === "none") {
    data.externalVideoUrl = null;
  }

  if (data.videoType === "uploaded") {
    errors.push("Uploaded videos are not enabled until secure asset verification is configured.");
  }

  return { data, errors };
}

/* GET /api/admin/transcription/learning */
router.get("/", async (req, res) => {
  try {
    const lessons = await TranscriptionLesson.find({})
      .sort({ displayOrder: 1, createdAt: -1 })
      .lean();

    return res.json({ success: true, lessons });
  } catch (error) {
    console.error("Admin learning list error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load learning lessons."
    });
  }
});

/* POST /api/admin/transcription/learning */
router.post("/", async (req, res) => {
  try {
    const { data, errors } = validateLesson(req.body || {});

    if (errors.length) {
      return res.status(400).json({
        success: false,
        message: errors[0],
        errors
      });
    }

    const lesson = await TranscriptionLesson.create({
      ...data,
      published: data.published ?? false,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      message: "Learning lesson created.",
      lesson
    });
  } catch (error) {
    console.error("Admin learning create error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not create this lesson."
    });
  }
});

/* PATCH /api/admin/transcription/learning/:id */
router.patch("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid lesson reference."
      });
    }

    const { data, errors } = validateLesson(req.body || {}, true);

    if (errors.length) {
      return res.status(400).json({
        success: false,
        message: errors[0],
        errors
      });
    }

    if (!Object.keys(data).length) {
      return res.status(400).json({
        success: false,
        message: "No valid lesson changes were supplied."
      });
    }

    const lesson = await TranscriptionLesson.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          ...data,
          updatedBy: req.user._id
        }
      },
      {
        returnDocument: "after",
        runValidators: true
      }
    );

    if (!lesson) {
      return res.status(404).json({
        success: false,
        message: "Lesson not found."
      });
    }

    return res.json({
      success: true,
      message: "Learning lesson updated.",
      lesson
    });
  } catch (error) {
    console.error("Admin learning update error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not update this lesson."
    });
  }
});

/* DELETE /api/admin/transcription/learning/:id */
router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid lesson reference."
      });
    }

    const lesson = await TranscriptionLesson.findByIdAndDelete(req.params.id);

    if (!lesson) {
      return res.status(404).json({
        success: false,
        message: "Lesson not found."
      });
    }

    return res.json({
      success: true,
      message: "Learning lesson deleted."
    });
  } catch (error) {
    console.error("Admin learning delete error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not delete this lesson."
    });
  }
});

module.exports = router;
