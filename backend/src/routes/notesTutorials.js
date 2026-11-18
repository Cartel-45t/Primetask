"use strict";

const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const requireNotesMembership = require("../middleware/requireNotesMembership");
const NotesTutorial = require("../models/NotesTutorial");

const router = express.Router();

router.use(requireAuth, requireNotesMembership);

router.get("/", async (req, res) => {
  try {
    const tutorials = await NotesTutorial.find({ status: "published" })
      .select("title description category secureUrl format durationSeconds sortOrder publishedAt createdAt")
      .sort({ sortOrder: 1, publishedAt: -1 })
      .lean();

    return res.json({ success: true, tutorials });
  } catch (error) {
    console.error("Notes tutorials retrieval error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to load tutorials."
    });
  }
});

module.exports = router;
