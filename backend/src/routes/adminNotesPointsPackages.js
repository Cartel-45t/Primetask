"use strict";

const express = require("express");
const mongoose = require("mongoose");
const requireAuth = require("../middleware/requireAuth");
const Package = require("../models/NotesPointsPackage");

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

function publicPackage(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    points: doc.points,
    priceKes: doc.priceKes,
    isActive: doc.isActive,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

function validateInput(body, partial = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const allowed = ["name", "points", "priceKes", "isActive"];
  const keys = Object.keys(body);

  if (!keys.length || keys.some(key => !allowed.includes(key))) return null;

  if (!partial && !["name", "points", "priceKes"].every(key => keys.includes(key))) {
    return null;
  }

  if (
    "name" in body &&
    (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120)
  ) return null;

  if (
    "points" in body &&
    (!Number.isSafeInteger(body.points) || body.points < 1 || body.points > 100000000)
  ) return null;

  if (
    "priceKes" in body &&
    (!Number.isSafeInteger(body.priceKes) || body.priceKes < 1 || body.priceKes > 100000000)
  ) return null;

  if ("isActive" in body && typeof body.isActive !== "boolean") return null;

  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      key === "name" ? value.trim() : value
    ])
  );
}

router.get("/", async (req, res) => {
  try {
    const packages = await Package.find({})
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.json({
      success: true,
      packages: packages.map(publicPackage)
    });
  } catch (error) {
    console.error("Admin Notes Points package listing error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load Notes Points packages."
    });
  }
});

router.post("/", async (req, res) => {
  const input = validateInput(req.body);

  if (!input) {
    return res.status(400).json({
      success: false,
      message: "Provide a package name, positive whole-number Points quantity, and positive whole-number KSh price."
    });
  }

  try {
    const doc = await Package.create({
      ...input,
      createdByAdminId: req.user._id
    });

    return res.status(201).json({
      success: true,
      package: publicPackage(doc)
    });
  } catch (error) {
    console.error("Admin Notes Points package creation error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to create the Notes Points package."
    });
  }
});

router.patch("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid package ID."
    });
  }

  const input = validateInput(req.body, true);

  if (!input) {
    return res.status(400).json({
      success: false,
      message: "Package changes contain invalid or unsupported fields."
    });
  }

  try {
    const doc = await Package.findByIdAndUpdate(
      req.params.id,
      { $set: input },
      { new: true, runValidators: true }
    );

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Notes Points package not found."
      });
    }

    return res.json({
      success: true,
      package: publicPackage(doc)
    });
  } catch (error) {
    console.error("Admin Notes Points package update error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to update the Notes Points package."
    });
  }
});

module.exports = router;
