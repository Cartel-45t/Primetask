"use strict";

const express = require("express");
const NotesPointsTransaction = require("../models/NotesPointsTransaction");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

router.use(requireAuth);

router.get("/", async (req, res) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(50, Math.max(1, requestedLimit))
      : 50;

    const transactions = await NotesPointsTransaction.find({
      userId: req.user._id
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    return res.json({
      success: true,
      unit: "Notes Points",
      transactions: transactions.map((item) => ({
        id: String(item._id),
        type: item.type,
        points: item.points,
        description: item.description,
        reference: item.reference,
        createdAt: item.createdAt
      }))
    });
  } catch (error) {
    console.error("Notes Points transaction history error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not load Notes Points transaction history."
    });
  }
});

module.exports = router;
