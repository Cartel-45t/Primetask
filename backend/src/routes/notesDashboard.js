"use strict";

const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const NotesWallet = require("../models/NotesWallet");
const NotesTransaction = require("../models/NotesTransaction");
const NotesTask = require("../models/NotesTask");

const router = express.Router();

router.use(requireAuth);

router.get("/", async (req, res) => {
  try {
    const wallet = await NotesWallet.findOneAndUpdate(
      { userId: req.user._id },
      { $setOnInsert: { userId: req.user._id } },
      {
        upsert: true,
        returnDocument: "after",
        setDefaultsOnInsert: true
      }
    );

    const [availableWork, myAssignments, transactions] = await Promise.all([
      NotesTask.countDocuments({ status: "available" }),
      NotesTask.countDocuments({
        assignedUserId: req.user._id,
        status: { $in: ["assigned", "submitted"] }
      }),
      NotesTransaction.find({ userId: req.user._id })
        .sort({ createdAt: -1 })
        .limit(6)
        .select("type amountCents description createdAt")
        .lean()
    ]);

    const firstName = String(req.user.firstName || "").trim();
    const username = String(req.user.username || "").trim();

    return res.json({
      dashboard: {
        userName: firstName || username || "Notes member",
        currency: "USD",
        availableWork,
        myAssignments,
        walletBalanceCents: wallet.availableBalanceCents,
        totalEarningsCents: wallet.totalEarningsCents,
        activity: transactions.map(item => ({
          type: item.type,
          amountCents: item.amountCents,
          description: item.description || item.type,
          createdAt: item.createdAt
        }))
      }
    });
  } catch (error) {
    console.error("Notes dashboard error:", error.message);

    return res.status(500).json({
      message: "Unable to load your Notes dashboard."
    });
  }
});

module.exports = router;
