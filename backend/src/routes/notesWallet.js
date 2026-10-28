"use strict";

const express = require("express");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const NotesWallet = require("../models/NotesWallet");
const NotesTransaction = require("../models/NotesTransaction");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();
router.use(requireAuth);

function centsToUSD(cents) {
  return Number((cents / 100).toFixed(2));
}

function validCents(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function creditReference(userId, key) {
  const digest = crypto
    .createHash("sha256")
    .update(`${userId}:${key}`)
    .digest("hex");

  return `NOTES-CREDIT-${userId}-${digest}`;
}

function transactionUnavailable(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    error?.code === 20 ||
    error?.code === 251 ||
    message.includes("transaction numbers are only allowed") ||
    message.includes("replica set") ||
    message.includes("does not support transactions")
  );
}

async function readWallet(userId) {
  const wallet = await NotesWallet.findOneAndUpdate(
    { userId },
    {
      $setOnInsert: {
        userId,
        availableBalanceCents: 0,
        reservedBalanceCents: 0,
        totalPurchasedCents: 0,
        totalSpentCents: 0,
        totalEarningsCents: 0
      }
    },
    {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true
    }
  ).lean();

  return wallet;
}

router.get("/", async (req, res) => {
  try {
    const userId = req.user._id;

    const [notesWallet, mainWallet] = await Promise.all([
      readWallet(userId),
      Wallet.findOne({ userId }).lean()
    ]);

    return res.json({
      success: true,
      currency: "USD",
      wallet: {
        availableBalanceCents: notesWallet.availableBalanceCents,
        reservedBalanceCents: notesWallet.reservedBalanceCents,
        totalPurchasedCents: notesWallet.totalPurchasedCents,
        totalSpentCents: notesWallet.totalSpentCents,
        totalEarningsCents: notesWallet.totalEarningsCents,
        availableBalance: centsToUSD(notesWallet.availableBalanceCents),
        reservedBalance: centsToUSD(notesWallet.reservedBalanceCents),
        totalPurchased: centsToUSD(notesWallet.totalPurchasedCents),
        totalSpent: centsToUSD(notesWallet.totalSpentCents),
        totalEarnings: centsToUSD(notesWallet.totalEarningsCents),
        updatedAt: notesWallet.updatedAt
      },
      mainWallet: {
        availableBalanceCents: mainWallet?.availableBalanceCents || 0,
        availableBalance: centsToUSD(
          mainWallet?.availableBalanceCents || 0
        )
      }
    });
  } catch (error) {
    console.error("Notes wallet retrieval error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load your Notes wallet."
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

router.post("/credits", async (req, res) => {
  const amountCents = req.body?.amountCents;
  const key = String(req.get("Idempotency-Key") || "").trim();

  if (!validCents(amountCents)) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid amount in whole USD cents."
    });
  }

  if (amountCents < 100) {
    return res.status(400).json({
      success: false,
      message: "The minimum Notes credit transfer is $1.00."
    });
  }

  if (
    amountCents > 100000000 ||
    !/^[A-Za-z0-9._:-]{8,100}$/.test(key)
  ) {
    return res.status(400).json({
      success: false,
      message: "The amount or idempotency key is invalid."
    });
  }

  const userId = req.user._id;
  const reference = creditReference(userId, key);

  try {
    const existing = await NotesTransaction.findOne({ reference }).lean();

    if (existing) {
      const wallet = await readWallet(userId);
      return res.json({
        success: true,
        duplicate: true,
        currency: "USD",
        transferredCents: existing.amountCents,
        transferredAmount: centsToUSD(existing.amountCents),
        notesBalanceCents: wallet.availableBalanceCents,
        notesBalance: centsToUSD(wallet.availableBalanceCents),
        message: "This transfer was already processed."
      });
    }

    const session = await mongoose.startSession();
    let result;

    try {
      await session.withTransaction(async () => {
        const prior = await NotesTransaction.findOne({ reference })
          .session(session)
          .lean();

        if (prior) {
          result = {
            duplicate: true,
            transferredCents: prior.amountCents
          };
          return;
        }

        const mainWallet = await Wallet.findOneAndUpdate(
          {
            userId,
            availableBalanceCents: { $gte: amountCents }
          },
          {
            $inc: { availableBalanceCents: -amountCents }
          },
          {
            returnDocument: "after",
            session,
            runValidators: true
          }
        );

        if (!mainWallet) {
          const error = new Error("INSUFFICIENT_MAIN_WALLET_FUNDS");
          error.code = "INSUFFICIENT_MAIN_WALLET_FUNDS";
          throw error;
        }

        await NotesWallet.updateOne(
          { userId },
          {
            $setOnInsert: {
              userId,
              availableBalanceCents: 0,
              reservedBalanceCents: 0,
              totalPurchasedCents: 0,
              totalSpentCents: 0,
              totalEarningsCents: 0
            }
          },
          {
            upsert: true,
            session,
            setDefaultsOnInsert: true
          }
        );

        const notesWallet = await NotesWallet.findOneAndUpdate(
          { userId },
          {
            $inc: {
              availableBalanceCents: amountCents,
              totalPurchasedCents: amountCents
            }
          },
          {
            returnDocument: "after",
            session,
            runValidators: true
          }
        );

        await WalletTransaction.create([{
          userId,
          type: "transfer_out",
          amountCents,
          currency: "USD",
          status: "completed",
          reference,
          description: "Transfer to PrimeTask Notes wallet",
          completedAt: new Date()
        }], { session });

        await NotesTransaction.create([{
          userId,
          walletId: notesWallet._id,
          type: "credit_purchase",
          amountCents,
          reference,
          description: "Credits transferred from PrimeTask wallet",
          metadata: { source: "main_wallet" }
        }], { session });

        result = {
          duplicate: false,
          transferredCents: amountCents,
          notesBalanceCents: notesWallet.availableBalanceCents
        };
      });
    } finally {
      await session.endSession();
    }

    if (result?.duplicate) {
      const wallet = await readWallet(userId);
      return res.json({
        success: true,
        duplicate: true,
        currency: "USD",
        transferredCents: result.transferredCents,
        transferredAmount: centsToUSD(result.transferredCents),
        notesBalanceCents: wallet.availableBalanceCents,
        notesBalance: centsToUSD(wallet.availableBalanceCents),
        message: "This transfer was already processed."
      });
    }

    return res.status(201).json({
      success: true,
      duplicate: false,
      currency: "USD",
      transferredCents: result.transferredCents,
      transferredAmount: centsToUSD(result.transferredCents),
      notesBalanceCents: result.notesBalanceCents,
      notesBalance: centsToUSD(result.notesBalanceCents),
      message: "Notes credits added successfully."
    });
  } catch (error) {
    if (error.code === "INSUFFICIENT_MAIN_WALLET_FUNDS") {
      return res.status(400).json({
        success: false,
        code: "INSUFFICIENT_FUNDS",
        message: "Your main wallet does not have enough available USD."
      });
    }

    if (error.code === 11000) {
      try {
        const existing = await NotesTransaction.findOne({ reference }).lean();

        if (existing) {
          const wallet = await readWallet(userId);
          return res.json({
            success: true,
            duplicate: true,
            currency: "USD",
            transferredCents: existing.amountCents,
            transferredAmount: centsToUSD(existing.amountCents),
            notesBalanceCents: wallet.availableBalanceCents,
            notesBalance: centsToUSD(wallet.availableBalanceCents),
            message: "This transfer was already processed."
          });
        }
      } catch (_) {
        // Preserve the original database error below.
      }
    }

    if (transactionUnavailable(error)) {
      return res.status(503).json({
        success: false,
        code: "TRANSACTIONS_UNAVAILABLE",
        message: "Secure wallet transfers require MongoDB transaction support."
      });
    }

    console.error("Notes credit transfer error:", error.message);
    return res.status(500).json({
      success: false,
      message: "The Notes credit transfer could not be completed."
    });
  }
});

module.exports = router;
