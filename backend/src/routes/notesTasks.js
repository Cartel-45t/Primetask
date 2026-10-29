"use strict";

const express = require("express");
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2;
const crypto = require("node:crypto");

const requireAuth = require("../middleware/requireAuth");
const NotesTask = require("../models/NotesTask");
const NotesPointsWallet = require("../models/NotesPointsWallet");
const NotesPointsTransaction = require("../models/NotesPointsTransaction");
const NotesSubmission = require("../models/NotesSubmission");

const router = express.Router();
const ASSIGNMENT_WINDOW_MS = 45 * 60 * 1000;

router.use(requireAuth);

function publicTask(task) {
  return {
    id: String(task._id),
    title: task.title,
    description: task.description || "",
    category: task.category || "General",
    expectedNotes: task.expectedNotes || "",
    brief: task.brief || "",
    deliverables: task.deliverables || [],
    durationMinutes: task.durationMinutes,
    pointsCost: task.durationMinutes,
    rewardCents: Math.ceil(task.durationMinutes / 5) * 100,
    audioAvailable: Boolean(task.audioPublicId && task.audioDurationSeconds > 0),
    currency: "USD",
    status: task.status,
    createdAt: task.createdAt
  };
}

function publicAssignment(task) {
  return {
    ...publicTask(task),
    claimedAt: task.claimedAt,
    assignmentExpiresAt: task.assignmentExpiresAt,
    submittedAt: task.submittedAt,
    completedAt: task.completedAt
  };
}

router.get("/available", async (req, res) => {
  try {
    const tasks = await NotesTask.find({ status: "available" })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return res.json({
      success: true,
      tasks: tasks.map(publicTask)
    });
  } catch (error) {
    console.error("Notes available tasks error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to load Notes tasks."
    });
  }
});

router.get("/mine", async (req, res) => {
  try {
    const tasks = await NotesTask.find({
      assignedUserId: req.user._id,
      status: { $in: ["assigned", "submitted", "completed"] }
    })
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();

    return res.json({
      success: true,
      assignments: tasks.map(publicAssignment)
    });
  } catch (error) {
    console.error("Notes assignments error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to load your Notes assignments."
    });
  }
});



/*
 * GET /api/notes/tasks/submissions
 * Return only the authenticated member's Notes submission history.
 */
router.get("/submissions", async (req, res) => {
  try {
    const submissions = await NotesSubmission.find({
      userId: req.user._id
    })
      .sort({ submittedAt: -1, _id: -1 })
      .limit(100)
      .populate({
        path: "taskId",
        select: "durationMinutes"
      })
      .lean();

    return res.json({
      success: true,
      submissions: submissions.map((item) => {
        const task = item.taskId && typeof item.taskId === "object"
          ? item.taskId
          : null;

        const duration = task?.durationMinutes;
        const validDuration = Number.isSafeInteger(duration) &&
          duration >= 1 &&
          duration <= 1440;

        return {
          id: String(item._id),
          taskId: item.taskId?._id
            ? String(item.taskId._id)
            : String(item.taskId || ""),
          taskTitle: item.taskTitle,
          status: item.status,
          submittedAt: item.submittedAt,
          reviewedAt: item.reviewedAt,
          reviewNotes: item.reviewNotes || "",
          rewardCents: validDuration
            ? Math.ceil(duration / 5) * 100
            : null,
          currency: "USD"
        };
      })
    });
  } catch (error) {
    console.error("Member Notes submission history error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load your Notes submission history."
    });
  }
});

router.get("/:id/audio", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({
      success: false,
      message: "Audio is not available."
    });
  }

  try {
    const task = await NotesTask.findById(req.params.id).lean();

    if (!task || !task.audioPublicId || !task.audioDurationSeconds) {
      return res.status(404).json({
        success: false,
        message: "Audio is not available."
      });
    }

    const role = String(req.user?.role || "").toLowerCase();
    const isAdmin = role === "admin" || role === "founder";
    const isPublicTask = task.status === "available";
    const isOwnAssignment =
      ["assigned", "submitted", "completed"].includes(task.status) &&
      String(task.assignedUserId || "") === String(req.user?._id || "");

    if (!isAdmin && !isPublicTask && !isOwnAssignment) {
      return res.status(404).json({
        success: false,
        message: "Audio is not available."
      });
    }

    const allowedFormats = new Set([
      "mp3", "wav", "m4a", "ogg", "flac", "webm"
    ]);
    const format = String(task.audioFormat || "").toLowerCase();
    const publicId = String(task.audioPublicId || "");
    const expectedPrefix = "primetask-workspace/note-taking/audio/";

    if (
      !allowedFormats.has(format) ||
      !publicId.startsWith(expectedPrefix) ||
      !/^[A-Za-z0-9_-]+$/.test(publicId.slice(expectedPrefix.length))
    ) {
      return res.status(404).json({
        success: false,
        message: "Audio is not available."
      });
    }

    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true
    });

    const asset = await cloudinary.api.resource(publicId, {
      resource_type: "video",
      type: "authenticated"
    });

    if (
      asset.public_id !== publicId ||
      asset.resource_type !== "video" ||
      asset.type !== "authenticated" ||
      !allowedFormats.has(String(asset.format || "").toLowerCase())
    ) {
      return res.status(404).json({
        success: false,
        message: "Audio is not available."
      });
    }

    const signedUrl = cloudinary.utils.private_download_url(
      publicId,
      format,
      {
        resource_type: "video",
        type: "authenticated",
        expires_at: Math.floor(Date.now() / 1000) + 60
      }
    );

    const downloadUrl = new URL(signedUrl);
    if (
      downloadUrl.protocol !== "https:" ||
      downloadUrl.hostname !== "api.cloudinary.com"
    ) {
      throw new Error("Unexpected Cloudinary download destination.");
    }

    const upstreamHeaders = {};
    if (req.headers.range) {
      upstreamHeaders.Range = req.headers.range;
    }

    const upstream = await fetch(downloadUrl, {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "error"
    });

    if (![200, 206, 416].includes(upstream.status)) {
      await upstream.body?.cancel().catch(() => {});
      return res.status(502).json({
        success: false,
        message: "Audio playback is temporarily unavailable."
      });
    }

    const mimeTypes = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      m4a: "audio/mp4",
      ogg: "audio/ogg",
      flac: "audio/flac",
      webm: "audio/webm"
    };

    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Type", mimeTypes[format]);

    for (const header of ["content-length", "content-range"]) {
      const value = upstream.headers.get(header);
      if (value) {
        res.setHeader(
          header.split("-").map(part =>
            part.charAt(0).toUpperCase() + part.slice(1)
          ).join("-"),
          value
        );
      }
    }

    if (upstream.status === 416) {
      await upstream.body?.cancel().catch(() => {});
      return res.status(416).end();
    }

    if (!upstream.body) {
      return res.status(502).json({
        success: false,
        message: "Audio playback is temporarily unavailable."
      });
    }

    res.status(upstream.status);

    const { Readable } = require("node:stream");
    Readable.fromWeb(upstream.body)
      .on("error", error => {
        console.error("Notes audio stream error:", error.message);
        if (!res.headersSent) {
          res.status(502);
        }
        res.destroy(error);
      })
      .pipe(res);
  } catch (error) {
    if (error.http_code === 404 || error.statusCode === 404) {
      return res.status(404).json({
        success: false,
        message: "Audio is not available."
      });
    }

    console.error("Notes audio playback error:", error.message);

    if (!res.headersSent) {
      return res.status(502).json({
        success: false,
        message: "Audio playback is temporarily unavailable."
      });
    }

    return res.destroy(error);
  }
});

router.post("/:id/claim", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid task ID."
    });
  }

  const session = await mongoose.startSession();

  try {
    let claimedTask = null;

    await session.withTransaction(async () => {
      const task = await NotesTask.findOne({
        _id: req.params.id,
        status: "available",
        durationMinutes: { $gte: 1 }
      }).session(session);

      if (!task) {
        const error = new Error("TASK_UNAVAILABLE");
        error.code = "TASK_UNAVAILABLE";
        throw error;
      }

      const pointsCost = task.durationMinutes;

      await NotesPointsWallet.findOneAndUpdate(
        { userId: req.user._id },
        { $setOnInsert: { userId: req.user._id } },
        {
          upsert: true,
          new: true,
          session,
          setDefaultsOnInsert: true
        }
      );

      const wallet = await NotesPointsWallet.findOneAndUpdate(
        {
          userId: req.user._id,
          balancePoints: { $gte: pointsCost }
        },
        {
          $inc: {
            balancePoints: -pointsCost,
            totalSpentPoints: pointsCost
          }
        },
        {
          new: true,
          session,
          runValidators: true
        }
      );

      if (!wallet) {
        const error = new Error("INSUFFICIENT_NOTES_POINTS");
        error.code = "INSUFFICIENT_NOTES_POINTS";
        throw error;
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + ASSIGNMENT_WINDOW_MS);

      const updatedTask = await NotesTask.findOneAndUpdate(
        { _id: task._id, status: "available" },
        {
          $set: {
            status: "assigned",
            assignedUserId: req.user._id,
            claimedAt: now,
            assignmentExpiresAt: expiresAt
          }
        },
        {
          new: true,
          session,
          runValidators: true
        }
      );

      if (!updatedTask) {
        const error = new Error("TASK_UNAVAILABLE");
        error.code = "TASK_UNAVAILABLE";
        throw error;
      }

      await NotesPointsTransaction.create([{
        userId: req.user._id,
        walletId: wallet._id,
        type: "task_claim",
        points: -pointsCost,
        reference: `NOTES-POINTS-CLAIM-${task._id}-${crypto.randomUUID()}`,
        description: `Notes Points charged for task: ${task.title}`,
        metadata: {
          taskId: String(task._id),
          durationMinutes: task.durationMinutes,
          assignmentExpiresAt: expiresAt.toISOString(),
          refundPolicy: "No refunds for expired or abandoned assignments."
        }
      }], { session });

      claimedTask = updatedTask;
    });

    return res.status(200).json({
      success: true,
      assignment: publicAssignment(claimedTask)
    });
  } catch (error) {
    if (["TASK_UNAVAILABLE", "INSUFFICIENT_NOTES_POINTS"].includes(error.code)) {
      const unavailable = error.code === "TASK_UNAVAILABLE";

      return res.status(unavailable ? 409 : 402).json({
        success: false,
        code: error.code,
        message: unavailable
          ? "This task is no longer available."
          : "Your Notes Points balance is insufficient for this task."
      });
    }

    console.error("Notes task claim error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to claim this Notes task."
    });
  } finally {
    await session.endSession();
  }
});

/*
 * POST /api/notes/tasks/:id/submissions
 * Accept one text submission for the member's active assignment.
 * Assignment expiry is enforced by the server, not the browser timer.
 */
router.post("/:id/submissions", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid task ID."
    });
  }

  const notesText = typeof req.body?.notesText === "string"
    ? req.body.notesText.trim()
    : "";

  if (!notesText) {
    return res.status(400).json({
      success: false,
      message: "Write your notes before submitting."
    });
  }

  if (notesText.length > 200000) {
    return res.status(400).json({
      success: false,
      message: "Notes cannot exceed 200,000 characters."
    });
  }

  const session = await mongoose.startSession();

  try {
    let savedSubmission = null;

    await session.withTransaction(async () => {
      const now = new Date();

      const task = await NotesTask.findOne({
        _id: req.params.id,
        assignedUserId: req.user._id,
        status: "assigned",
        assignmentExpiresAt: { $gt: now }
      }).session(session);

      if (!task) {
        const error = new Error("ASSIGNMENT_NOT_ACTIVE");
        error.code = "ASSIGNMENT_NOT_ACTIVE";
        throw error;
      }

      const existing = await NotesSubmission.findOne({
        taskId: task._id,
        userId: req.user._id
      }).session(session);

      if (existing) {
        const error = new Error("SUBMISSION_EXISTS");
        error.code = "SUBMISSION_EXISTS";
        throw error;
      }

      const submission = await NotesSubmission.create([{
        taskId: task._id,
        userId: req.user._id,
        taskTitle: task.title,
        notesText,
        status: "submitted",
        submittedAt: now
      }], { session });

      const updatedTask = await NotesTask.findOneAndUpdate(
        {
          _id: task._id,
          assignedUserId: req.user._id,
          status: "assigned",
          assignmentExpiresAt: { $gt: now }
        },
        {
          $set: {
            status: "submitted",
            submittedAt: now
          }
        },
        {
          new: true,
          session,
          runValidators: true
        }
      );

      if (!updatedTask) {
        const error = new Error("ASSIGNMENT_NOT_ACTIVE");
        error.code = "ASSIGNMENT_NOT_ACTIVE";
        throw error;
      }

      savedSubmission = submission[0];
    });

    return res.status(201).json({
      success: true,
      message: "Notes submitted successfully.",
      submission: {
        id: String(savedSubmission._id),
        taskId: String(savedSubmission.taskId),
        status: savedSubmission.status,
        submittedAt: savedSubmission.submittedAt
      }
    });
  } catch (error) {
    if (["ASSIGNMENT_NOT_ACTIVE", "SUBMISSION_EXISTS"].includes(error.code)) {
      const alreadySubmitted = error.code === "SUBMISSION_EXISTS";

      return res.status(409).json({
        success: false,
        code: error.code,
        message: alreadySubmitted
          ? "A submission already exists for this assignment."
          : "This assignment has expired, is no longer active, or does not belong to you."
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        code: "SUBMISSION_EXISTS",
        message: "A submission already exists for this assignment."
      });
    }

    console.error("Notes submission error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to submit your notes."
    });
  } finally {
    await session.endSession();
  }
});

module.exports = router;
