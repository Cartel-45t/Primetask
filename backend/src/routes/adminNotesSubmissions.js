"use strict";

const express = require("express");
const mongoose = require("mongoose");

const requireAuth = require("../middleware/requireAuth");
const NotesTask = require("../models/NotesTask");
const NotesWallet = require("../models/NotesWallet");
const NotesTransaction = require("../models/NotesTransaction");
const NotesSubmission = require("../models/NotesSubmission");

const router = express.Router();

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

function reviewText(value) {
  if (value === undefined || value === null) return "";

  if (typeof value !== "string") {
    throw new Error("Review notes must be text.");
  }

  const result = value.trim();

  if (result.length > 5000) {
    throw new Error("Review notes cannot exceed 5,000 characters.");
  }

  return result;
}

const NOTES_TASK_REWARD_CENTS = 300;

function publicSubmission(item) {
  const member = item.userId && typeof item.userId === "object"
    ? item.userId
    : null;

  const task = item.taskId && typeof item.taskId === "object"
    ? item.taskId
    : null;

  return {
    id: String(item._id),
    taskId: task ? String(task._id) : String(item.taskId),
    taskTitle: item.taskTitle,
    taskStatus: task?.status || null,
    rewardCents: task ? NOTES_TASK_REWARD_CENTS : null,
    currency: "USD",
    member: member ? {
      id: String(member._id),
      username: member.username || "",
      firstName: member.firstName || "",
      lastName: member.lastName || "",
      email: member.email || ""
    } : null,
    notesText: item.notesText,
    status: item.status,
    submittedAt: item.submittedAt,
    reviewedAt: item.reviewedAt,
    reviewedByAdminId: item.reviewedByAdminId
      ? String(item.reviewedByAdminId)
      : null,
    reviewNotes: item.reviewNotes || "",
    createdAt: item.createdAt
  };
}

router.get("/", async (req, res) => {
  const status = typeof req.query.status === "string"
    ? req.query.status
    : "submitted";

  if (!["submitted", "approved", "rejected"].includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Status must be submitted, approved, or rejected."
    });
  }

  const parsedLimit = Number.parseInt(req.query.limit, 10) || 30;
  const limit = Math.min(50, Math.max(1, parsedLimit));

  try {
    const submissions = await NotesSubmission.find({ status })
      .sort({ submittedAt: 1, _id: 1 })
      .limit(limit)
      .populate({
        path: "userId",
        select: "username firstName lastName email"
      })
      .populate({
        path: "taskId",
        select: "title status rewardCents durationMinutes"
      })
      .lean();

    return res.json({
      success: true,
      status,
      submissions: submissions.map(publicSubmission)
    });
  } catch (error) {
    console.error("Admin Notes submission listing error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load Notes submissions."
    });
  }
});

router.patch("/:id/review", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid submission ID."
    });
  }

  const action = req.body?.action;

  if (!["approve", "reject"].includes(action)) {
    return res.status(400).json({
      success: false,
      message: "Action must be approve or reject."
    });
  }

  let notes;

  try {
    notes = reviewText(req.body?.reviewNotes);
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }

  if (action === "reject" && !notes) {
    return res.status(400).json({
      success: false,
      message: "Review notes are required when rejecting a submission."
    });
  }

  const session = await mongoose.startSession();

  try {
    let result = null;

    await session.withTransaction(async () => {
      const submission = await NotesSubmission.findOne({
        _id: req.params.id,
        status: "submitted"
      }).session(session);

      if (!submission) {
        const error = new Error("SUBMISSION_NOT_REVIEWABLE");
        error.code = "SUBMISSION_NOT_REVIEWABLE";
        throw error;
      }

      const task = await NotesTask.findOne({
        _id: submission.taskId,
        status: "submitted",
        assignedUserId: submission.userId
      }).session(session);

      if (!task) {
        const error = new Error("TASK_NOT_REVIEWABLE");
        error.code = "TASK_NOT_REVIEWABLE";
        throw error;
      }

      const now = new Date();

      if (action === "approve") {
        if (
          !Number.isSafeInteger(task.durationMinutes) ||
          task.durationMinutes < 1 ||
          task.durationMinutes > 1440
        ) {
          const error = new Error("INVALID_TASK_REWARD");
          error.code = "INVALID_TASK_REWARD";
          throw error;
        }

        const rewardCents = NOTES_TASK_REWARD_CENTS;

        await NotesWallet.updateOne(
          { userId: submission.userId },
          {
            $setOnInsert: {
              userId: submission.userId,
              availableBalanceCents: 0,
              reservedBalanceCents: 0,
              totalPurchasedCents: 0,
              totalSpentCents: 0,
              totalEarningsCents: 0
            }
          },
          {
            upsert: true,
            session,
            setDefaultsOnInsert: true
          }
        );

        const wallet = await NotesWallet.findOneAndUpdate(
          { userId: submission.userId },
          {
            $inc: {
              availableBalanceCents: rewardCents,
              totalEarningsCents: rewardCents
            }
          },
          {
            returnDocument: "after",
            session,
            runValidators: true
          }
        );

        if (!wallet) {
          const error = new Error("NOTES_WALLET_UNAVAILABLE");
          error.code = "NOTES_WALLET_UNAVAILABLE";
          throw error;
        }

        const updatedTask = await NotesTask.findOneAndUpdate(
          {
            _id: task._id,
            status: "submitted",
            assignedUserId: submission.userId
          },
          {
            $set: {
              status: "completed",
              completedAt: now
            }
          },
          {
            returnDocument: "after",
            session,
            runValidators: true
          }
        );

        if (!updatedTask) {
          const error = new Error("TASK_NOT_REVIEWABLE");
          error.code = "TASK_NOT_REVIEWABLE";
          throw error;
        }

        const reference = `NOTES-EARNING-${submission._id}`;

        await NotesTransaction.create([{
          userId: submission.userId,
          walletId: wallet._id,
          type: "task_earning",
          amountCents: rewardCents,
          reference,
          description: `Earnings for approved Notes task: ${task.title}`,
          metadata: {
            taskId: String(task._id),
            submissionId: String(submission._id),
            reviewedByAdminId: String(req.user._id)
          }
        }], { session });

        submission.status = "approved";
        submission.reviewedAt = now;
        submission.reviewedByAdminId = req.user._id;
        submission.reviewNotes = notes;

        await submission.save({ session });

        result = {
          action,
          submissionId: String(submission._id),
          taskId: String(task._id),
          rewardCents,
          walletBalanceCents: wallet.availableBalanceCents,
          status: submission.status
        };
      } else {
        const updatedTask = await NotesTask.findOneAndUpdate(
          {
            _id: task._id,
            status: "submitted",
            assignedUserId: submission.userId
          },
          {
            $set: {
              status: "archived"
            }
          },
          {
            returnDocument: "after",
            session,
            runValidators: true
          }
        );

        if (!updatedTask) {
          const error = new Error("TASK_NOT_REVIEWABLE");
          error.code = "TASK_NOT_REVIEWABLE";
          throw error;
        }

        submission.status = "rejected";
        submission.reviewedAt = now;
        submission.reviewedByAdminId = req.user._id;
        submission.reviewNotes = notes;

        await submission.save({ session });

        result = {
          action,
          submissionId: String(submission._id),
          taskId: String(task._id),
          rewardCents: 0,
          status: submission.status
        };
      }
    });

    return res.json({
      success: true,
      message: action === "approve"
        ? "Submission approved and earnings credited."
        : "Submission rejected. No earnings were credited.",
      review: result
    });
  } catch (error) {
    if ([
      "SUBMISSION_NOT_REVIEWABLE",
      "TASK_NOT_REVIEWABLE"
    ].includes(error.code)) {
      return res.status(409).json({
        success: false,
        code: error.code,
        message: "This submission has already been reviewed or its task is no longer reviewable."
      });
    }

    if (error.code === "INVALID_TASK_REWARD") {
      return res.status(409).json({
        success: false,
        code: error.code,
        message: "The task has an invalid reward and cannot be approved."
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        code: "DUPLICATE_EARNING",
        message: "An earnings record already exists for this submission."
      });
    }

    console.error("Admin Notes submission review error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to review this Notes submission."
    });
  } finally {
    await session.endSession();
  }
});

module.exports = router;
