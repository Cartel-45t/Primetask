"use strict";

const express = require("express");
const mongoose = require("mongoose");
const requireAuth = require("../middleware/requireAuth");
const PlatformAnnouncement = require("../models/PlatformAnnouncement");

const router = express.Router();
const adminRouter = express.Router();
function serialize(item) {
  return {
    id: String(item._id),
    title: item.title,
    message: item.message,
    status: item.status,
    startsAt: item.startsAt,
    endsAt: item.endsAt || null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function validDates(body) {
  const startsAt = body.startsAt === undefined ? new Date() : new Date(body.startsAt);
  const endsAt = body.endsAt === undefined || body.endsAt === null || body.endsAt === ""
    ? null
    : new Date(body.endsAt);
  if (Number.isNaN(startsAt.getTime()) || (endsAt && Number.isNaN(endsAt.getTime()))) return null;
  if (endsAt && endsAt <= startsAt) return null;
  return { startsAt, endsAt };
}

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const now = new Date();
    const items = await PlatformAnnouncement.find({
      status: "published",
      startsAt: { $lte: now },
      $or: [{ endsAt: null }, { endsAt: { $gt: now } }]
    }).sort({ createdAt: -1 }).limit(50).lean();
    return res.json({ success: true, announcements: items.map(serialize) });
  } catch (error) { return next(error); }
});

adminRouter.use(requireAuth);
adminRouter.use((req, res, next) => {
  if (!["admin", "founder"].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: "Administrator access is required." });
  }
  next();
});

adminRouter.get("/", async (req, res, next) => {
  try {
    const items = await PlatformAnnouncement.find({}).sort({ createdAt: -1 }).limit(100).lean();
    return res.json({ success: true, announcements: items.map(serialize) });
  } catch (error) { return next(error); }
});

adminRouter.post("/", async (req, res, next) => {
  try {
    const { title, message } = req.body || {};
    if (typeof title !== "string" || !title.trim() || title.trim().length > 120 ||
        typeof message !== "string" || !message.trim() || message.trim().length > 5000) {
      return res.status(400).json({ success: false, message: "Provide a title (1–120 characters) and message (1–5000 characters)." });
    }
    const status = req.body.status === undefined ? "published" : req.body.status;
    if (!["published", "draft"].includes(status)) {
      return res.status(400).json({ success: false, message: "status must be published or draft." });
    }
    const dates = validDates(req.body);
    if (!dates) return res.status(400).json({ success: false, message: "Announcement dates are invalid; end date must be after start date." });
    const item = await PlatformAnnouncement.create({
      title: title.trim(), message: message.trim(), status,
      ...dates, createdBy: req.user._id
    });
    return res.status(201).json({ success: true, announcement: serialize(item) });
  } catch (error) { return next(error); }
});

adminRouter.patch("/:id", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid announcement ID." });
    const item = await PlatformAnnouncement.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: "Announcement not found." });
    const body = req.body || {};
    if (Object.keys(body).some(key => !["title", "message", "status", "startsAt", "endsAt"].includes(key))) {
      return res.status(400).json({ success: false, message: "Unsupported announcement field." });
    }
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 120) return res.status(400).json({ success: false, message: "Title must be 1–120 characters." });
      item.title = body.title.trim();
    }
    if (body.message !== undefined) {
      if (typeof body.message !== "string" || !body.message.trim() || body.message.trim().length > 5000) return res.status(400).json({ success: false, message: "Message must be 1–5000 characters." });
      item.message = body.message.trim();
    }
    if (body.status !== undefined) {
      if (!["published", "draft", "archived"].includes(body.status)) return res.status(400).json({ success: false, message: "Invalid announcement status." });
      item.status = body.status;
    }
    if (body.startsAt !== undefined || body.endsAt !== undefined) {
      const dates = validDates({ startsAt: body.startsAt ?? item.startsAt, endsAt: body.endsAt === undefined ? item.endsAt : body.endsAt });
      if (!dates) return res.status(400).json({ success: false, message: "Announcement dates are invalid; end date must be after start date." });
      item.startsAt = dates.startsAt;
      item.endsAt = dates.endsAt;
    }
    item.updatedBy = req.user._id;
    await item.save();
    return res.json({ success: true, announcement: serialize(item) });
  } catch (error) { return next(error); }
});

adminRouter.delete("/:id", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid announcement ID." });
    const item = await PlatformAnnouncement.findByIdAndUpdate(req.params.id, { $set: { status: "archived", updatedBy: req.user._id } }, { new: true });
    if (!item) return res.status(404).json({ success: false, message: "Announcement not found." });
    return res.json({ success: true, announcement: serialize(item) });
  } catch (error) { return next(error); }
});

module.exports = { user: router, admin: adminRouter };