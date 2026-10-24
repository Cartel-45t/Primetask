"use strict";

const express = require("express");
const mongoose = require("mongoose");
const requireAuth = require("../middleware/requireAuth");
const Notification = require("../models/Notification");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isInteger(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 100))
      : 50;

    const notifications = await Notification.find({
      recipientId: req.user._id
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({
      success: true,
      notifications: notifications.map((item) => ({
        id: String(item._id),
        type: item.type,
        conversationId: item.conversationId
          ? String(item.conversationId)
          : null,
        messageId: item.messageId ? String(item.messageId) : null,
        readAt: item.readAt || null,
        createdAt: item.createdAt
      }))
    });
  } catch (error) {
    console.error("Notification list error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load notifications."
    });
  }
});

router.patch("/read-all", requireAuth, async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { recipientId: req.user._id, readAt: null },
      { $set: { readAt: new Date() } }
    );

    return res.json({
      success: true,
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    console.error("Mark all notifications read error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to update notifications."
    });
  }
});

router.patch("/:id/read", requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid notification ID."
    });
  }

  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipientId: req.user._id },
      { $set: { readAt: new Date() } },
      { new: true }
    ).lean();

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found."
      });
    }

    return res.json({
      success: true,
      notification: {
        id: String(notification._id),
        readAt: notification.readAt
      }
    });
  } catch (error) {
    console.error("Mark notification read error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to update notification."
    });
  }
});

module.exports = router;
