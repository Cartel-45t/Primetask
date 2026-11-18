"use strict";

const express = require("express");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const cloudinary = require("cloudinary").v2;

const requireAuth = require("../middleware/requireAuth");
const NotesTutorial = require("../models/NotesTutorial");

const router = express.Router();
const FOLDER = "primetask-workspace/note-taking/tutorials";
const MAX_BYTES = 500 * 1024 * 1024;
const FORMATS = ["mp4", "mov", "webm", "m4v"];

router.use(requireAuth);
router.use((req, res, next) => {
  if (!["admin", "founder"].includes(
    String(req.user?.role || "").toLowerCase()
  )) {
    return res.status(403).json({
      success: false,
      message: "Admin access required."
    });
  }
  next();
});

function configureCloudinary() {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } =
    process.env;

  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error("Cloudinary environment configuration is incomplete.");
  }

  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET
  });
}

router.get("/", async (req, res) => {
  try {
    const tutorials = await NotesTutorial.find({})
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();

    return res.json({ success: true, tutorials });
  } catch (error) {
    console.error("Admin tutorials retrieval error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to load tutorials."
    });
  }
});

router.post("/signature", async (req, res) => {
  try {
    configureCloudinary();

    const timestamp = Math.floor(Date.now() / 1000);
    const publicId = `${FOLDER}/${crypto.randomUUID()}`;

    const params = {
      timestamp,
      public_id: publicId,
      overwrite: false,
      allowed_formats: FORMATS.join(",")
    };

    const signature = cloudinary.utils.api_sign_request(
      params,
      process.env.CLOUDINARY_API_SECRET
    );

    return res.json({
      success: true,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      signature,
      params
    });
  } catch (error) {
    console.error("Tutorial upload signature error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not authorize the video upload."
    });
  }
});

router.post("/", async (req, res) => {
  const title = typeof req.body?.title === "string"
    ? req.body.title.trim() : "";
  const description = typeof req.body?.description === "string"
    ? req.body.description.trim() : "";
  const category = typeof req.body?.category === "string"
    ? req.body.category.trim() : "General";
  const publicId = typeof req.body?.publicId === "string"
    ? req.body.publicId.trim() : "";

  if (!title || title.length > 120) {
    return res.status(400).json({
      success: false,
      message: "Enter a title of up to 120 characters."
    });
  }

  if (description.length > 2000 || category.length > 60) {
    return res.status(400).json({
      success: false,
      message: "Description or category is too long."
    });
  }

  const expectedPrefix = `${FOLDER}/`;
  const validId = new RegExp(
    "^" + expectedPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
    "[a-f0-9-]{36}$",
    "i"
  );

  if (!validId.test(publicId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid tutorial upload reference."
    });
  }

  try {
    configureCloudinary();

    const asset = await cloudinary.api.resource(publicId, {
      resource_type: "video",
      type: "upload"
    });

    if (
      !FORMATS.includes(String(asset.format || "").toLowerCase()) ||
      !asset.secure_url ||
      !Number.isFinite(asset.bytes) ||
      asset.bytes <= 0 ||
      asset.bytes > MAX_BYTES
    ) {
      return res.status(400).json({
        success: false,
        message: "The uploaded video is invalid or exceeds 500 MB."
      });
    }

    const tutorial = await NotesTutorial.create({
      title,
      description,
      category: category || "General",
      publicId,
      secureUrl: asset.secure_url,
      format: asset.format,
      bytes: asset.bytes,
      durationSeconds: Number(asset.duration) || 0,
      status: "draft",
      createdByAdminId: req.user._id
    });

    return res.status(201).json({
      success: true,
      message: "Tutorial uploaded and saved as a draft.",
      tutorial
    });
  } catch (error) {
    if (error.http_code === 404) {
      return res.status(400).json({
        success: false,
        message: "Cloudinary could not find the uploaded video."
      });
    }

    console.error("Tutorial creation error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to save the tutorial."
    });
  }
});

router.patch("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid tutorial ID." });
  }

  const updates = {};
  if (typeof req.body?.title === "string") {
    updates.title = req.body.title.trim();
  }
  if (typeof req.body?.description === "string") {
    updates.description = req.body.description.trim();
  }
  if (typeof req.body?.category === "string") {
    updates.category = req.body.category.trim();
  }
  if (Number.isInteger(req.body?.sortOrder)) {
    updates.sortOrder = req.body.sortOrder;
  }

  if (
    (updates.title !== undefined && (!updates.title || updates.title.length > 120)) ||
    (updates.description !== undefined && updates.description.length > 2000) ||
    (updates.category !== undefined && updates.category.length > 60)
  ) {
    return res.status(400).json({ success: false, message: "Invalid tutorial details." });
  }

  try {
    const tutorial = await NotesTutorial.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!tutorial) {
      return res.status(404).json({ success: false, message: "Tutorial not found." });
    }

    return res.json({ success: true, tutorial });
  } catch (error) {
    console.error("Tutorial update error:", error);
    return res.status(500).json({ success: false, message: "Unable to update tutorial." });
  }
});

router.patch("/:id/publish", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid tutorial ID." });
  }

  try {
    const tutorial = await NotesTutorial.findById(req.params.id);
    if (!tutorial) {
      return res.status(404).json({ success: false, message: "Tutorial not found." });
    }

    tutorial.status = "published";
    tutorial.publishedAt = new Date();
    await tutorial.save();

    return res.json({ success: true, message: "Tutorial published.", tutorial });
  } catch (error) {
    console.error("Tutorial publishing error:", error);
    return res.status(500).json({ success: false, message: "Unable to publish tutorial." });
  }
});

router.patch("/:id/unpublish", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid tutorial ID." });
  }

  try {
    const tutorial = await NotesTutorial.findByIdAndUpdate(
      req.params.id,
      { $set: { status: "draft", publishedAt: null } },
      { new: true }
    );

    if (!tutorial) {
      return res.status(404).json({ success: false, message: "Tutorial not found." });
    }

    return res.json({ success: true, message: "Tutorial unpublished.", tutorial });
  } catch (error) {
    console.error("Tutorial unpublishing error:", error);
    return res.status(500).json({ success: false, message: "Unable to unpublish tutorial." });
  }
});

router.delete("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid tutorial ID." });
  }

  try {
    configureCloudinary();

    const tutorial = await NotesTutorial.findById(req.params.id);
    if (!tutorial) {
      return res.status(404).json({ success: false, message: "Tutorial not found." });
    }

    await cloudinary.uploader.destroy(tutorial.publicId, {
      resource_type: "video",
      type: "upload"
    });

    await tutorial.deleteOne();

    return res.json({ success: true, message: "Tutorial deleted." });
  } catch (error) {
    console.error("Tutorial deletion error:", error);
    return res.status(500).json({ success: false, message: "Unable to delete tutorial." });
  }
});

module.exports = router;
