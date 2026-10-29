"use strict";

const express = require("express");
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2;
const path = require("node:path");
const requireAuth = require("../middleware/requireAuth");
const NotesTask = require("../models/NotesTask");

const router = express.Router();

const NOTES_AUDIO_FOLDER = "primetask-workspace/note-taking/audio";
const NOTES_AUDIO_FORMATS = ["mp3", "wav", "m4a", "ogg", "flac", "webm"];
const NOTES_AUDIO_MAX_BYTES = 100 * 1024 * 1024;

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

function expectedNotesAudioId(publicId) {
  return typeof publicId === "string" &&
    /^primetask-workspace\/note-taking\/audio\/[A-Za-z0-9_-]+$/.test(publicId);
}

function safeAudioName(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  return path.basename(value.trim()).slice(0, 180);
}

async function verifyNotesAudio(publicId, originalName) {
  if (!expectedNotesAudioId(publicId)) {
    const error = new Error("Invalid Notes audio asset reference.");
    error.status = 400;
    throw error;
  }

  if (!cloudinaryReady()) {
    const error = new Error("Audio storage is not configured on the server.");
    error.status = 503;
    throw error;
  }

  configureCloudinary();

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
    !NOTES_AUDIO_FORMATS.includes(format) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > NOTES_AUDIO_MAX_BYTES ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > 1440 * 60
  ) {
    const error = new Error("Cloudinary could not verify a valid Notes audio file and duration.");
    error.status = 422;
    throw error;
  }

  return {
    publicId: asset.public_id,
    originalName: safeAudioName(originalName) || "audio",
    format,
    bytes,
    durationSeconds,
    durationMinutes: Math.ceil(durationSeconds / 60)
  };
}

router.use(requireAuth);

router.use((req, res, next) => {
  if (!["admin", "founder"].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: "Admin access is required."
    });
  }

  next();
});

function cleanText(value, maxLength, field, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required.`);
    return "";
  }

  if (typeof value !== "string") {
    throw new Error(`${field} must be text.`);
  }

  const result = value.trim();

  if (required && !result) {
    throw new Error(`${field} is required.`);
  }

  if (result.length > maxLength) {
    throw new Error(`${field} exceeds ${maxLength} characters.`);
  }

  return result;
}

function safeDuration(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1440) {
    throw new Error("Duration must be a positive whole number of minutes, up to 1440.");
  }

  return value;
}

function rewardForDuration(durationMinutes) {
  return Math.ceil(durationMinutes / 5) * 100;
}

function adminTask(task) {
  return {
    id: String(task._id),
    title: task.title,
    description: task.description,
    category: task.category,
    expectedNotes: task.expectedNotes,
    brief: task.brief,
    deliverables: task.deliverables,
    durationMinutes: task.durationMinutes,
    audioAvailable: Boolean(task.audioPublicId && task.audioDurationSeconds > 0),
    audioOriginalName: task.audioOriginalName || "",
    audioFormat: task.audioFormat || "",
    audioBytes: task.audioBytes || 0,
    audioDurationSeconds: task.audioDurationSeconds || 0,
    pointsCost: task.durationMinutes,
    rewardCents: rewardForDuration(task.durationMinutes),
    currency: "USD",
    status: task.status,
    assignedUserId: task.assignedUserId
      ? String(task.assignedUserId)
      : null,
    createdAt: task.createdAt,
    publishedAt: task.publishedAt
  };
}

router.get("/", async (req, res) => {
  try {
    const tasks = await NotesTask.find({})
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.json({
      success: true,
      tasks: tasks.map(adminTask)
    });
  } catch (error) {
    console.error("Admin Notes task listing error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to load Notes tasks."
    });
  }
});

router.post("/", async (req, res) => {
  try {
    const body = req.body || {};

    const title = cleanText(body.title, 180, "Title", true);
    const description = cleanText(body.description, 10000, "Description");
    const category = cleanText(body.category, 100, "Category") || "General";
    const expectedNotes = cleanText(body.expectedNotes, 5000, "Expected notes");
    const brief = cleanText(body.brief, 10000, "Brief");
    const audio = await verifyNotesAudio(body.audioPublicId, body.audioOriginalName);
    const durationMinutes = safeDuration(audio.durationMinutes);
    const rewardCents = rewardForDuration(durationMinutes);
    const taskCostCents = durationMinutes;

    const deliverables = body.deliverables === undefined
      ? []
      : body.deliverables;

    if (
      !Array.isArray(deliverables) ||
      deliverables.length > 30 ||
      deliverables.some(item =>
        typeof item !== "string" ||
        !item.trim() ||
        item.trim().length > 500
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Deliverables must be an array of up to 30 non-empty strings, each no longer than 500 characters."
      });
    }

    const task = await NotesTask.create({
      title,
      description,
      category,
      expectedNotes,
      brief,
      deliverables: deliverables.map(item => item.trim()),
      audioPublicId: audio.publicId,
      audioOriginalName: audio.originalName,
      audioFormat: audio.format,
      audioBytes: audio.bytes,
      audioDurationSeconds: audio.durationSeconds,
      durationMinutes,
      rewardCents,
      taskCostCents,
      status: "draft",
      createdByAdminId: req.user._id
    });

    return res.status(201).json({
      success: true,
      message: "Notes task saved as a draft.",
      task: adminTask(task)
    });
  } catch (error) {
    if (
      error.message.includes(" is required.") ||
      error.message.includes(" must be text.") ||
      error.message.includes(" exceeds ") ||
      error.message.includes("must be a positive whole number")
    ) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    console.error("Admin Notes task creation error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to create the Notes task."
    });
  }
});

router.patch("/:id/publish", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid task ID."
    });
  }

  try {
    const draft = await NotesTask.findOne({
      _id: req.params.id,
      status: "draft",
      durationMinutes: { $gte: 1, $lte: 1440 },
      audioPublicId: /^primetask-workspace\/note-taking\/audio\/[A-Za-z0-9_-]+$/,
      audioDurationSeconds: { $gt: 0 },
      audioBytes: { $gt: 0 }
    }).lean();

    if (!draft) {
      return res.status(409).json({
        success: false,
        message: "Task not found, not a draft, or missing a valid duration."
      });
    }

    const task = await NotesTask.findOneAndUpdate(
      {
        _id: draft._id,
        status: "draft",
        durationMinutes: draft.durationMinutes
      },
      {
        $set: {
          status: "available",
          rewardCents: rewardForDuration(draft.durationMinutes),
          publishedAt: new Date()
        }
      },
      {
        new: true,
        runValidators: true
      }
    );

    if (!task) {
      return res.status(409).json({
        success: false,
        message: "The task changed before it could be published. Refresh and try again."
      });
    }

    return res.json({
      success: true,
      message: "Notes task published.",
      task: adminTask(task)
    });
  } catch (error) {
    console.error("Admin Notes task publishing error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to publish the Notes task."
    });
  }
});

module.exports = router;
