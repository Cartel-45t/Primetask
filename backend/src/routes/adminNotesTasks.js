"use strict";

const express = require("express");
const mongoose = require("mongoose");
const requireAuth = require("../middleware/requireAuth");
const NotesTask = require("../models/NotesTask");

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

function safeCents(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive whole number of USD cents.`);
  }

  return value;
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
    taskCostCents: task.taskCostCents,
    rewardCents: task.rewardCents,
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
    const rewardCents = safeCents(body.rewardCents, "Reward");
    const taskCostCents = safeCents(body.taskCostCents, "Task cost");

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
    const task = await NotesTask.findOneAndUpdate(
      {
        _id: req.params.id,
        status: "draft",
        taskCostCents: { $gte: 1 },
        rewardCents: { $gte: 1 }
      },
      {
        $set: {
          status: "available",
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
        message: "Task not found, not a draft, or missing valid cost and reward values."
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
