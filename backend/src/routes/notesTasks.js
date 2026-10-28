"use strict";

const express = require("express");
const mongoose = require("mongoose");
const crypto = require("node:crypto");

const requireAuth = require("../middleware/requireAuth");
const NotesTask = require("../models/NotesTask");
const NotesWallet = require("../models/NotesWallet");
const NotesTransaction = require("../models/NotesTransaction");
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
    rewardCents: task.rewardCents,
    taskCostCents: task.taskCostCents,
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
        taskCostCents: { $gte: 1 }
      }).session(session);

      if (!task) {
        const error = new Error("TASK_UNAVAILABLE");
        error.code = "TASK_UNAVAILABLE";
        throw error;
      }

      // Ensure every member has a Notes wallet before checking its balance.
      // This creates a zero-balance wallet only; it never grants credits.
      await NotesWallet.findOneAndUpdate(
        { userId: req.user._id },
        { $setOnInsert: { userId: req.user._id } },
        {
          upsert: true,
          new: true,
          session,
          setDefaultsOnInsert: true
        }
      );

      const wallet = await NotesWallet.findOneAndUpdate(
        {
          userId: req.user._id,
          availableBalanceCents: { $gte: task.taskCostCents }
        },
        {
          $inc: {
            availableBalanceCents: -task.taskCostCents,
            totalSpentCents: task.taskCostCents
          }
        },
        {
          new: true,
          session,
          runValidators: true
        }
      );

      if (!wallet) {
        const error = new Error("INSUFFICIENT_NOTES_CREDITS");
        error.code = "INSUFFICIENT_NOTES_CREDITS";
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

      await NotesTransaction.create([{
        userId: req.user._id,
        walletId: wallet._id,
        type: "task_debit",
        amountCents: task.taskCostCents,
        reference: `NOTES-DEBIT-${task._id}-${crypto.randomUUID()}`,
        description: `Notes task cost charged for: ${task.title}`,
        metadata: {
          taskId: String(task._id),
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
    if (["TASK_UNAVAILABLE", "INSUFFICIENT_NOTES_CREDITS"].includes(error.code)) {
      const status = error.code === "TASK_UNAVAILABLE" ? 409 : 402;
      const message = error.code === "TASK_UNAVAILABLE"
        ? "This task is no longer available."
        : "Your Notes wallet has insufficient available credits.";

      return res.status(status).json({
        success: false,
        code: error.code,
        message
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
