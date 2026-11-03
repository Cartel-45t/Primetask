"use strict";

const express = require("express");
const router = express.Router();

const requireAuth = require("../middleware/requireAuth");
const Testimonial = require("../models/Testimonial");
const Membership = require("../models/Membership");
const User = require("../models/User");

function fullName(user) {
  return [user?.firstName, user?.lastName]
    .filter(Boolean).join(" ").trim() || "PrimeTask Member";
}

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

// Public testimonials: approved records from active accounts only.
router.get("/", async (req, res, next) => {
  try {
    const items = await Testimonial.find({ status: "approved" })
      .populate({
        path: "userId",
        select: "firstName lastName profilePictureUrl status"
      })
      .sort({ featured: -1, reviewedAt: -1, createdAt: -1 })
      .limit(12)
      .lean();

    const active = items.filter(
      item => item.userId?.status === "active"
    );

    const memberships = await membershipMap(
      active.map(item => item.userId._id)
    );

    return res.json({
      success: true,
      data: active.map(item => ({
        id: String(item._id),
        message: item.message,
        featured: Boolean(item.featured),
        createdAt: item.createdAt,
        member: {
          fullName: fullName(item.userId),
          profilePictureUrl: item.userId.profilePictureUrl || null,
          membershipName:
            memberships.get(String(item.userId._id)) ||
            "Community Member"
        }
      }))
    });
  } catch (error) {
    return next(error);
  }
});

// A member can view their own submission regardless of membership.
router.get("/mine", requireAuth, async (req, res, next) => {
  try {
    const [item, user, memberships] = await Promise.all([
      Testimonial.findOne({ userId: req.user._id }).lean(),
      User.findById(req.user._id)
        .select("firstName lastName profilePictureUrl")
        .lean(),
      membershipMap([req.user._id])
    ]);

    return res.json({
      success: true,
      data: {
        testimonial: item ? {
          id: String(item._id),
          message: item.message,
          status: item.status,
          featured: Boolean(item.featured),
          adminNote: item.adminNote || "",
          createdAt: item.createdAt,
          updatedAt: item.updatedAt
        } : null,
        member: {
          fullName: fullName(user),
          profilePictureUrl: user?.profilePictureUrl || null,
          membershipName:
            memberships.get(String(req.user._id)) ||
            "Community Member"
        }
      }
    });
  } catch (error) {
    return next(error);
  }
});

// The server supplies identity. The browser cannot submit a name, photo or plan.
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const message = typeof req.body?.message === "string"
      ? req.body.message.trim()
      : "";

    if (message.length < 20 || message.length > 1200) {
      return res.status(400).json({
        success: false,
        message: "A testimonial must contain between 20 and 1,200 characters."
      });
    }

    let item = await Testimonial.findOne({ userId: req.user._id });

    if (!item) {
      item = new Testimonial({
        userId: req.user._id,
        message
      });
    } else {
      item.message = message;
      item.status = "pending";
      item.featured = false;
      item.reviewedBy = null;
      item.reviewedAt = null;
      item.adminNote = "";
    }

    await item.save();

    return res.json({
      success: true,
      message: "Your testimonial has been submitted for review.",
      data: {
        id: String(item._id),
        status: item.status
      }
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "A testimonial already exists for this account. Refresh and try again."
      });
    }

    return next(error);
  }
});

module.exports = router;
