"use strict";

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const requireAuth = require("../middleware/requireAuth");
const Testimonial = require("../models/Testimonial");
const Membership = require("../models/Membership");

router.use(requireAuth);

router.use((req, res, next) => {
  if (!["admin", "founder"].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: "Administrator access is required."
    });
  }

  next();
});

async function membershipMap(userIds) {
  if (!userIds.length) return new Map();

  const now = new Date();
  const records = await Membership.find({
    userId: { $in: userIds },
    status: "active",
    startsAt: { $lte: now },
    expiresAt: { $gt: now }
  })
    .populate("planId", "name key")
    .sort({ expiresAt: -1, _id: -1 })
    .lean();

  const result = new Map();

  for (const record of records) {
    const key = String(record.userId);

    if (!result.has(key)) {
      result.set(
        key,
        record.planId?.name || record.planKey || "Active Member"
      );
    }
  }

  return result;
}

router.get("/", async (req, res, next) => {
  try {
    const allowed = ["pending", "approved", "rejected", "all"];
    const status = allowed.includes(req.query.status)
      ? req.query.status
      : "pending";

    const items = await Testimonial.find(
      status === "all" ? {} : { status }
    )
      .populate({
        path: "userId",
        select: "firstName lastName username email profilePictureUrl status"
      })
      .populate({
        path: "reviewedBy",
        select: "firstName lastName username"
      })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const memberships = await membershipMap(
      items.map(item => item.userId?._id).filter(Boolean)
    );

    return res.json({
      success: true,
      data: items.map(item => ({
        id: String(item._id),
        message: item.message,
        status: item.status,
        featured: Boolean(item.featured),
        adminNote: item.adminNote || "",
        createdAt: item.createdAt,
        reviewedAt: item.reviewedAt,
        member: item.userId ? {
          id: String(item.userId._id),
          fullName: [
            item.userId.firstName,
            item.userId.lastName
          ].filter(Boolean).join(" "),
          username: item.userId.username,
          email: item.userId.email,
          profilePictureUrl: item.userId.profilePictureUrl || null,
          accountStatus: item.userId.status,
          membershipName:
            memberships.get(String(item.userId._id)) ||
            "Community Member"
        } : null,
        reviewedBy: item.reviewedBy ? {
          fullName: [
            item.reviewedBy.firstName,
            item.reviewedBy.lastName
          ].filter(Boolean).join(" "),
          username: item.reviewedBy.username
        } : null
      }))
    });
  } catch (error) {
    return next(error);
  }
});

async function review(req, res, next, status) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid testimonial identifier."
      });
    }

    const item = await Testimonial.findById(req.params.id);

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Testimonial not found."
      });
    }

    item.status = status;
    item.reviewedBy = req.user._id;
    item.reviewedAt = new Date();

    if (status !== "approved") item.featured = false;

    if (typeof req.body?.adminNote === "string") {
      item.adminNote = req.body.adminNote.trim().slice(0, 500);
    }

    await item.save();

    return res.json({
      success: true,
      message: `Testimonial ${status}.`,
      data: {
        id: String(item._id),
        status: item.status
      }
    });
  } catch (error) {
    return next(error);
  }
}

router.patch("/:id/approve", (req, res, next) =>
  review(req, res, next, "approved")
);

router.patch("/:id/reject", (req, res, next) =>
  review(req, res, next, "rejected")
);

router.patch("/:id/feature", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid testimonial identifier."
      });
    }

    if (typeof req.body?.featured !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "featured must be true or false."
      });
    }

    const item = await Testimonial.findById(req.params.id);

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Testimonial not found."
      });
    }

    if (req.body.featured && item.status !== "approved") {
      return res.status(409).json({
        success: false,
        message: "Only approved testimonials can be featured."
      });
    }

    item.featured = req.body.featured;
    await item.save();

    return res.json({
      success: true,
      data: {
        id: String(item._id),
        featured: item.featured
      }
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid testimonial identifier."
      });
    }

    const item = await Testimonial.findByIdAndDelete(req.params.id);

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Testimonial not found."
      });
    }

    return res.json({
      success: true,
      message: "Testimonial deleted."
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
