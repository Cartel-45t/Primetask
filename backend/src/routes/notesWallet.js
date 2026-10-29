"use strict";

const express = require("express");
const NotesWallet = require("../models/NotesWallet");
const NotesTransaction = require("../models/NotesTransaction");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();
router.use(requireAuth);

function centsToUSD(cents) {
  return Number((cents / 100).toFixed(2));
}

async function readWallet(userId) {
  return NotesWallet.findOneAndUpdate(
    { userId },
    {
      $setOnInsert: {
        userId,
        availableBalanceCents: 0,
        reservedBalanceCents: 0,
        totalPurchasedCents: 0,
        totalSpentCents: 0,
        totalEarningsCents: 0,
        totalWithdrawalsCents: 0
      }
    },
    {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true
    }
  ).lean();
}

router.get("/", async (req, res) => {
  try {
    const wallet = await readWallet(req.user._id);

    return res.json({
      success: true,
      currency: "USD",
      wallet: {
        availableBalanceCents: wallet.availableBalanceCents,
        reservedBalanceCents: wallet.reservedBalanceCents,
        totalPurchasedCents: wallet.totalPurchasedCents,
        totalSpentCents: wallet.totalSpentCents,
        totalEarningsCents: wallet.totalEarningsCents,
        totalWithdrawalsCents: wallet.totalWithdrawalsCents || 0,
        availableBalance: centsToUSD(wallet.availableBalanceCents),
        reservedBalance: centsToUSD(wallet.reservedBalanceCents),
        totalPurchased: centsToUSD(wallet.totalPurchasedCents),
        totalSpent: centsToUSD(wallet.totalSpentCents),
        totalEarnings: centsToUSD(wallet.totalEarningsCents),
        totalWithdrawals: centsToUSD(wallet.totalWithdrawalsCents || 0),
        updatedAt: wallet.updatedAt
      }
    });
  } catch (error) {
    console.error("Notes wallet retrieval error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load your Notes earnings wallet."
    });
  }
});

router.get("/transactions", async (req, res) => {
  try {
    const parsedLimit = Number.parseInt(req.query.limit, 10) || 20;
    const limit = Math.min(50, Math.max(1, parsedLimit));

    const transactions = await NotesTransaction.find({
      userId: req.user._id
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    return res.json({
      success: true,
      currency: "USD",
      transactions: transactions.map(item => ({
        id: item._id,
        type: item.type,
        amountCents: item.amountCents,
        amount: centsToUSD(Math.abs(item.amountCents)),
        description: item.description,
        reference: item.reference,
        createdAt: item.createdAt
      }))
    });
  } catch (error) {
    console.error("Notes transaction history error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load Notes transaction history."
    });
  }
});

// Main-wallet transfers are permanently disabled.
// Notes Points must be purchased through the separate M-Pesa purchase flow.
router.post("/credits", async (_req, res) => {
  return res.status(410).json({
    success: false,
    code: "NOTES_WALLET_TRANSFERS_DISABLED",
    message:
      "Transfers from the main PrimeTask wallet are disabled. Purchase Notes Points directly through M-Pesa."
  });
});

module.exports = router;
