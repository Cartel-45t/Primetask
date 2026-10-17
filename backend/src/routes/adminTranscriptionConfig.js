"use strict";

const express = require("express");
const mongoose = require("mongoose");
const requireAuth = require("../middleware/requireAuth");
const Settings = require("../models/TranscriptionSettings");
const MinutePackage = require("../models/TranscriptionMinutePackage");

const router = express.Router();

router.use(requireAuth);
router.use((req, res, next) => {
  if (!["admin", "founder"].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: "Administrator access required."
    });
  }
  next();
});

async function getSettings() {
  return Settings.findOneAndUpdate(
    { key: "transcription" },
    { $setOnInsert: { key: "transcription" } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  );
}

function publicSettings(doc) {
  return {
    defaultAudioTitle: doc.defaultAudioTitle,
    durationRewardRanges: doc.durationRewardRanges.map(range => ({
      id: String(range._id),
      minMinutes: range.minMinutes,
      maxMinutes: range.maxMinutes,
      rewardUsd: range.rewardUsd
    })),
    updatedAt: doc.updatedAt || null
  };
}

function validRanges(ranges) {
  if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > 100) {
    return false;
  }

  const sorted = [...ranges].sort((a, b) => a.minMinutes - b.minMinutes);

  for (let i = 0; i < sorted.length; i++) {
    const range = sorted[i];

    if (
      !Number.isSafeInteger(range.minMinutes) ||
      !Number.isSafeInteger(range.maxMinutes) ||
      !Number.isSafeInteger(range.rewardUsd) ||
      range.minMinutes < 1 ||
      range.maxMinutes < range.minMinutes ||
      range.maxMinutes > 10000 ||
      range.rewardUsd < 1 ||
      range.rewardUsd > 1000000
    ) {
      return false;
    }

    if (i > 0 && sorted[i - 1].maxMinutes >= range.minMinutes) {
      return false;
    }
  }

  return true;
}

function publicPackage(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    minutes: doc.minutes,
    price: doc.priceCents / 100,
    currency: "USD",
    priceKes: doc.priceKes,
    isActive: doc.isActive,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

function validPackageInput(body, partial = false) {
  const allowed = ["name", "minutes", "price", "priceKes", "isActive"];
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;

  const keys = Object.keys(body);
  if (!keys.length || keys.some(key => !allowed.includes(key))) return false;

  if (!partial && !["name", "minutes", "price", "priceKes"].every(key => keys.includes(key))) {
    return false;
  }

  if ("name" in body &&
      (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120)) {
    return false;
  }

  if ("minutes" in body &&
      (!Number.isSafeInteger(body.minutes) || body.minutes < 1 || body.minutes > 10000000)) {
    return false;
  }

  if ("price" in body &&
      (!Number.isSafeInteger(body.price) || body.price < 1 || body.price > 1000000)) {
    return false;
  }
  if ("priceKes" in body &&
      (!Number.isSafeInteger(body.priceKes) || body.priceKes < 1 || body.priceKes > 1000000000)) {
    return false;
  }

  if ("isActive" in body && typeof body.isActive !== "boolean") return false;

  return true;
}

router.get("/settings", async (req, res) => {
  try {
    const settings = await getSettings();
    return res.json({ success: true, settings: publicSettings(settings) });
  } catch (error) {
    console.error("Transcription settings read failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load transcription settings."
    });
  }
});

router.put("/settings", async (req, res) => {
  const body = req.body || {};
  const allowed = ["defaultAudioTitle", "durationRewardRanges"];
  const keys = Object.keys(body);

  if (
    !keys.length ||
    keys.some(key => !allowed.includes(key)) ||
    ("defaultAudioTitle" in body &&
      (typeof body.defaultAudioTitle !== "string" ||
       !body.defaultAudioTitle.trim() ||
       body.defaultAudioTitle.trim().length > 180)) ||
    ("durationRewardRanges" in body && !validRanges(body.durationRewardRanges))
  ) {
    return res.status(400).json({
      success: false,
      message: "Provide a valid default title and/or non-overlapping duration ranges with whole-dollar rewards."
    });
  }

  try {
    const settings = await getSettings();

    if ("defaultAudioTitle" in body) {
      settings.defaultAudioTitle = body.defaultAudioTitle.trim();
    }

    if ("durationRewardRanges" in body) {
      settings.durationRewardRanges = [...body.durationRewardRanges]
        .sort((a, b) => a.minMinutes - b.minMinutes);
    }

    settings.updatedBy = req.user._id;
    await settings.save();

    return res.json({
      success: true,
      message: "Transcription settings saved.",
      settings: publicSettings(settings)
    });
  } catch (error) {
    console.error("Transcription settings update failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not save transcription settings."
    });
  }
});

router.get("/packages", async (req, res) => {
  try {
    const filter = req.query.all === "true" ? {} : { isActive: true };
    const packages = await MinutePackage.find(filter).sort({ minutes: 1, createdAt: -1 });

    return res.json({
      success: true,
      packages: packages.map(publicPackage)
    });
  } catch (error) {
    console.error("Minute package list failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load minute packages."
    });
  }
});

router.post("/packages", async (req, res) => {
  const body = req.body || {};

  if (!validPackageInput(body)) {
    return res.status(400).json({
      success: false,
      message: "Provide a name, positive whole minutes, whole-dollar USD price, and positive whole-number M-Pesa price in KSh."
    });
  }

  try {
    const doc = await MinutePackage.create({
      name: body.name.trim(),
      minutes: body.minutes,
      priceCents: body.price * 100,
      priceKes: body.priceKes,
      isActive: true,
      createdByAdminId: req.user._id
    });

    return res.status(201).json({
      success: true,
      message: "Minute package created.",
      package: publicPackage(doc)
    });
  } catch (error) {
    console.error("Minute package create failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not create minute package."
    });
  }
});

router.patch("/packages/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid package ID." });
  }

  const body = req.body || {};
  if (!validPackageInput(body, true)) {
    return res.status(400).json({
      success: false,
      message: "Invalid package changes. USD price must be whole dollars and M-Pesa price must be a positive whole KSh amount."
    });
  }

  try {
    const doc = await MinutePackage.findById(req.params.id);

    if (!doc) {
      return res.status(404).json({ success: false, message: "Minute package not found." });
    }

    if ("name" in body) doc.name = body.name.trim();
    if ("minutes" in body) doc.minutes = body.minutes;
    if ("price" in body) doc.priceCents = body.price * 100;
    if ("priceKes" in body) doc.priceKes = body.priceKes;
    if ("isActive" in body) doc.isActive = body.isActive;

    await doc.save();

    return res.json({
      success: true,
      message: "Minute package updated.",
      package: publicPackage(doc)
    });
  } catch (error) {
    console.error("Minute package update failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not update minute package."
    });
  }
});

module.exports = router;
