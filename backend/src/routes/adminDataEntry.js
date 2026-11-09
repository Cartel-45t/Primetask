"use strict";

const express = require("express");
const mongoose = require("mongoose");
const requireAuth = require("../middleware/requireAuth");

const Order = require("../models/DataEntryOrder");
const Submission = require("../models/DataEntrySubmission");
const Wallet = require("../models/DataEntryWallet");
const Transaction = require("../models/DataEntryTransaction");
const BidWallet = require("../models/DataEntryBidWallet");
const BidTransaction = require("../models/DataEntryBidTransaction");
const BidPurchase = require("../models/DataEntryBidPurchase");
const Withdrawal = require("../models/DataEntryWithdrawal");

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

const validId = id => mongoose.isValidObjectId(id);

function validJobInput(body, partial = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const allowed = [
    "title", "description", "category", "instructions",
    "rewardCents", "requiredBids", "timeLimitMinutes",
    "acceptedFileFormats"
  ];

  const keys = Object.keys(body);
  if (!keys.length || keys.some(key => !allowed.includes(key))) return null;

  if (!partial && ![
    "title", "category", "rewardCents",
    "requiredBids", "timeLimitMinutes"
  ].every(key => keys.includes(key))) return null;

  if ("title" in body &&
      (typeof body.title !== "string" || !body.title.trim() ||
       body.title.trim().length > 180)) return null;

  if ("description" in body &&
      (typeof body.description !== "string" ||
       body.description.length > 10000)) return null;

  if ("instructions" in body &&
      (typeof body.instructions !== "string" ||
       body.instructions.length > 15000)) return null;

  if ("category" in body &&
      !["spreadsheet", "document", "research", "other"].includes(body.category)) {
    return null;
  }

  for (const key of ["rewardCents", "requiredBids", "timeLimitMinutes"]) {
    if (key in body &&
        (!Number.isSafeInteger(body[key]) || body[key] < 1)) return null;
  }

  if ("acceptedFileFormats" in body &&
      (!Array.isArray(body.acceptedFileFormats) ||
       body.acceptedFileFormats.length > 20 ||
       !body.acceptedFileFormats.every(x =>
         typeof x === "string" && /^[a-z0-9]{1,10}$/i.test(x)
       ))) return null;

  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      key === "title" ? value.trim() :
      key === "acceptedFileFormats"
        ? [...new Set(value.map(x => x.toLowerCase()))]
        : value
    ])
  );
}

/* Real platform figures. All earnings are USD cents; bid purchases are KES. */
router.get("/overview", async (_req, res) => {
  try {
    const [
      jobs, submissions, wallets, withdrawals, purchases,
      bidWallets, verifiedPurchaseTotals
    ] = await Promise.all([
      Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Submission.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Wallet.aggregate([{
        $group: {
          _id: null,
          availableCents: { $sum: "$availableBalanceCents" },
          reservedCents: { $sum: "$reservedBalanceCents" },
          earnedCents: { $sum: "$totalEarningsCents" },
          withdrawnCents: { $sum: "$totalWithdrawalsCents" }
        }
      }]),
      Withdrawal.aggregate([{ $group: { _id: "$status", count: { $sum: 1 }, amountCents: { $sum: "$amountCents" } } }]),
      BidPurchase.aggregate([{ $group: { _id: "$paymentStatus", count: { $sum: 1 } } }]),
      BidWallet.aggregate([{
        $group: {
          _id: null,
          activeBids: { $sum: "$balanceBids" },
          purchasedBids: { $sum: "$totalPurchasedBids" },
          spentBids: { $sum: "$totalSpentBids" }
        }
      }]),
      BidPurchase.aggregate([
        { $match: { paymentStatus: "verified" } },
        {
          $group: {
            _id: null,
            bidsSold: { $sum: "$bids" },
            revenueKes: { $sum: "$verifiedAmountKes" }
          }
        }
      ])
    ]);

    const countMap = rows =>
      Object.fromEntries(rows.map(row => [row._id, row.count]));

    const withdrawalMap = Object.fromEntries(
      withdrawals.map(row => [row._id, {
        count: row.count,
        amountCents: row.amountCents
      }])
    );

    const purchaseMap = countMap(purchases);
    const wallet = wallets[0] || {};
    const bidWallet = bidWallets[0] || {};
    const verified = verifiedPurchaseTotals[0] || {};

    return res.json({
      success: true,
      jobs: countMap(jobs),
      submissions: countMap(submissions),
      withdrawals: withdrawalMap,
      purchases: purchaseMap,
      earnings: {
        availableCents: wallet.availableCents || 0,
        reservedCents: wallet.reservedCents || 0,
        outstandingCents: (wallet.availableCents || 0) + (wallet.reservedCents || 0),
        totalEarnedCents: wallet.earnedCents || 0,
        totalWithdrawnCents: wallet.withdrawnCents || 0
      },
      bids: {
        activeBalances: bidWallet.activeBids || 0,
        purchasedBids: verified.bidsSold || 0,
        spentBids: bidWallet.spentBids || 0,
        verifiedRevenueKes: verified.revenueKes || 0
      }
    });
  } catch (error) {
    console.error("Data Entry admin overview:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load Data Entry overview."
    });
  }
});

/* Job management */
router.get("/jobs", async (_req, res) => {
  try {
    const jobs = await Order.find()
      .populate("assignedUserId", "name email")
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, jobs });
  } catch (error) {
    console.error("Data Entry admin jobs:", error.message);
    return res.status(500).json({ success: false, message: "Could not load jobs." });
  }
});

router.post("/jobs", async (req, res) => {
  const input = validJobInput(req.body);
  if (!input) {
    return res.status(400).json({ success: false, message: "Invalid job details." });
  }

  try {
    const job = await Order.create({
      ...input,
      createdByAdminId: req.user._id,
      status: "draft"
    });
    return res.status(201).json({ success: true, job });
  } catch (error) {
    console.error("Data Entry job creation:", error.message);
    return res.status(400).json({ success: false, message: "Could not create job." });
  }
});

router.patch("/jobs/:id", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid job ID." });
  }

  const input = validJobInput(req.body, true);
  if (!input) {
    return res.status(400).json({ success: false, message: "Invalid job changes." });
  }

  try {
    const job = await Order.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ["draft", "published"] } },
      { $set: input },
      { new: true, runValidators: true }
    );

    if (!job) {
      return res.status(409).json({
        success: false,
        message: "Only draft or published jobs can be edited."
      });
    }

    return res.json({ success: true, job });
  } catch (error) {
    console.error("Data Entry job update:", error.message);
    return res.status(400).json({ success: false, message: "Could not update job." });
  }
});

router.post("/jobs/:id/publish", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid job ID." });
  }

  try {
    const job = await Order.findOneAndUpdate(
      { _id: req.params.id, status: "draft" },
      { $set: { status: "published", publishedAt: new Date() } },
      { new: true, runValidators: true }
    );

    if (!job) {
      return res.status(409).json({
        success: false,
        message: "Only draft jobs can be published."
      });
    }

    return res.json({ success: true, job });
  } catch (error) {
    console.error("Data Entry job publish:", error.message);
    return res.status(500).json({ success: false, message: "Could not publish job." });
  }
});

router.post("/jobs/:id/cancel", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid job ID." });
  }

  try {
    const job = await Order.findOneAndUpdate(
      {
        _id: req.params.id,
        status: { $in: ["draft", "published", "assigned", "revision_requested"] }
      },
      {
        $set: {
          status: "cancelled",
          assignedUserId: null,
          assignmentExpiresAt: null
        }
      },
      { new: true, runValidators: true }
    );

    if (!job) {
      return res.status(409).json({
        success: false,
        message: "This job cannot be cancelled in its current state."
      });
    }

    return res.json({ success: true, job });
  } catch (error) {
    console.error("Data Entry job cancellation:", error.message);
    return res.status(500).json({ success: false, message: "Could not cancel job." });
  }
});

router.delete("/jobs/:id", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid job ID." });
  }

  try {
    const job = await Order.findOne({
      _id: req.params.id,
      status: { $in: ["draft", "published"] },
      assignedUserId: null
    });

    if (!job) {
      return res.status(409).json({
        success: false,
        message: "Only unassigned draft or published jobs can be deleted."
      });
    }

    const hasSubmission = await Submission.exists({ orderId: job._id });
    if (hasSubmission) {
      return res.status(409).json({
        success: false,
        message: "This job has submission history and cannot be deleted."
      });
    }

    await job.deleteOne();
    return res.json({ success: true, message: "Job deleted." });
  } catch (error) {
    console.error("Data Entry job deletion:", error.message);
    return res.status(500).json({ success: false, message: "Could not delete job." });
  }
});

/* Active worker assignments */
router.get("/in-progress", async (_req, res) => {
  try {
    const jobs = await Order.find({
      status: { $in: ["assigned", "revision_requested"] }
    })
      .populate("assignedUserId", "name email")
      .sort({ assignmentExpiresAt: 1 })
      .lean();

    return res.json({ success: true, jobs });
  } catch (error) {
    console.error("Data Entry in-progress:", error.message);
    return res.status(500).json({ success: false, message: "Could not load assignments." });
  }
});

/* Admin submission queue */
router.get("/submissions", async (req, res) => {
  const allowed = ["submitted", "approved", "rejected", "revision_requested"];
  const filter = {};
  if (req.query.status) {
    if (!allowed.includes(req.query.status)) {
      return res.status(400).json({ success: false, message: "Invalid submission status." });
    }
    filter.status = req.query.status;
  }

  try {
    const submissions = await Submission.find(filter)
      .populate("userId", "name email")
      .populate("orderId", "title category status")
      .sort({ submittedAt: -1 })
      .limit(300)
      .lean();

    return res.json({ success: true, submissions });
  } catch (error) {
    console.error("Data Entry admin submissions:", error.message);
    return res.status(500).json({ success: false, message: "Could not load submissions." });
  }
});


/* Review submissions and credit earnings atomically */
router.patch("/submissions/:id/review", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid submission ID." });
  }

  const { decision } = req.body || {};
  const reviewNote = typeof req.body?.reviewNote === "string"
    ? req.body.reviewNote.trim()
    : "";

  if (!["approved", "rejected", "revision_requested"].includes(decision)) {
    return res.status(400).json({
      success: false,
      message: "Decision must be approved, rejected or revision_requested."
    });
  }

  if (reviewNote.length > 2000) {
    return res.status(400).json({
      success: false,
      message: "Review note cannot exceed 2,000 characters."
    });
  }

  if (decision !== "approved" && !reviewNote) {
    return res.status(400).json({
      success: false,
      message: "A review note is required for rejection or revision."
    });
  }

  const session = await mongoose.startSession();

  try {
    let reviewedSubmission;

    await session.withTransaction(async () => {
      const submission = await Submission.findById(req.params.id).session(session);

      if (!submission) {
        const error = new Error("Submission not found.");
        error.statusCode = 404;
        throw error;
      }

      if (submission.status !== "submitted") {
        const error = new Error("Only submitted work can be reviewed.");
        error.statusCode = 409;
        throw error;
      }

      const order = await Order.findById(submission.orderId).session(session);

      if (!order || order.status !== "submitted") {
        const error = new Error("The associated job is not awaiting review.");
        error.statusCode = 409;
        throw error;
      }

      if (decision === "approved") {
        const wallet = await Wallet.findOneAndUpdate(
          { userId: submission.userId },
          {
            $setOnInsert: { userId: submission.userId },
            $inc: {
              availableBalanceCents: submission.rewardCents,
              totalEarningsCents: submission.rewardCents
            }
          },
          { new: true, upsert: true, runValidators: true, session }
        );

        const [earningTransaction] = await Transaction.create([{
          userId: submission.userId,
          walletId: wallet._id,
          type: "task_earning",
          amountCents: submission.rewardCents,
          reference: `DATA-ENTRY-EARNING-${submission._id}`,
          description: `Earning for Data Entry job: ${submission.orderTitle}`,
          submissionId: submission._id
        }], { session });

        submission.walletTransactionId = earningTransaction._id;

        order.status = "completed";
        order.completedAt = new Date();
      } else if (decision === "rejected") {
        // Preserve the rejected submission; reopen the job for another worker.
        order.status = "published";
        order.assignedUserId = null;
        order.claimedAt = null;
        order.assignmentExpiresAt = null;
        order.submittedAt = null;
        order.publishedAt = new Date();
      } else {
        // The same worker keeps the assignment and can revise without extra bids.
        order.status = "revision_requested";
      }

      submission.status = decision;
      submission.reviewNote = reviewNote;
      submission.reviewedBy = req.user._id;
      submission.reviewedAt = new Date();
      submission.reviewHistory.push({
        reviewNote,
        reviewedBy: req.user._id,
        reviewedAt: new Date(),
        decision
      });

      await submission.save({ session });
      await order.save({ session });

      reviewedSubmission = submission;
    });

    return res.json({
      success: true,
      message: decision === "approved"
        ? "Submission approved and earnings credited."
        : decision === "rejected"
          ? "Submission rejected. Job returned to the public queue."
          : "Revision requested. Job remains assigned to the worker.",
      submission: reviewedSubmission
    });
  } catch (error) {
    console.error("Data Entry submission review:", error.message);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode
        ? error.message
        : "Could not complete submission review."
    });
  } finally {
    await session.endSession();
  }
});


/* Worker earnings ledger: USD cents */
router.get("/earnings", async (req, res) => {
  try {
    const filter = {};
    if (req.query.userId) {
      if (!validId(req.query.userId)) {
        return res.status(400).json({ success: false, message: "Invalid user ID." });
      }
      filter.userId = req.query.userId;
    }

    const [wallets, transactions] = await Promise.all([
      Wallet.find(filter).populate("userId", "name email").sort({ updatedAt: -1 }).lean(),
      Transaction.find(filter)
        .populate("userId", "name email")
        .sort({ createdAt: -1 })
        .limit(500)
        .lean()
    ]);

    return res.json({
      success: true,
      currency: "USD",
      wallets,
      transactions
    });
  } catch (error) {
    console.error("Data Entry earnings:", error.message);
    return res.status(500).json({ success: false, message: "Could not load earnings." });
  }
});

/* Immutable worker wallet transaction history */
router.get("/transactions", async (req, res) => {
  try {
    const filter = {};
    if (req.query.userId) {
      if (!validId(req.query.userId)) {
        return res.status(400).json({ success: false, message: "Invalid user ID." });
      }
      filter.userId = req.query.userId;
    }
    if (req.query.type) {
      const allowed = ["task_earning", "admin_adjustment", "withdrawal", "withdrawal_reversal"];
      if (!allowed.includes(req.query.type)) {
        return res.status(400).json({ success: false, message: "Invalid transaction type." });
      }
      filter.type = req.query.type;
    }

    const transactions = await Transaction.find(filter)
      .populate("userId", "name email")
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    return res.json({ success: true, currency: "USD", transactions });
  } catch (error) {
    console.error("Data Entry transactions:", error.message);
    return res.status(500).json({ success: false, message: "Could not load transactions." });
  }
});

/* Bid wallet ledger: bids and purchase amounts are separate from USD earnings */
router.get("/bid-transactions", async (req, res) => {
  try {
    const filter = {};
    if (req.query.userId) {
      if (!validId(req.query.userId)) {
        return res.status(400).json({ success: false, message: "Invalid user ID." });
      }
      filter.userId = req.query.userId;
    }

    const transactions = await BidTransaction.find(filter)
      .populate("userId", "name email")
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    return res.json({ success: true, transactions });
  } catch (error) {
    console.error("Data Entry bid transactions:", error.message);
    return res.status(500).json({ success: false, message: "Could not load bid transactions." });
  }
});

/* Bid purchase records: KES revenue only from verified payments */
router.get("/bid-purchases", async (_req, res) => {
  try {
    const purchases = await BidPurchase.find()
      .populate("userId", "name email")
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    const totals = await BidPurchase.aggregate([
      {
        $group: {
          _id: "$paymentStatus",
          count: { $sum: 1 },
          verifiedKes: {
            $sum: {
              $cond: [
                { $eq: ["$paymentStatus", "verified"] },
                "$verifiedAmountKes",
                0
              ]
            }
          },
          verifiedBids: {
            $sum: {
              $cond: [
                { $eq: ["$paymentStatus", "verified"] },
                "$bids",
                0
              ]
            }
          }
        }
      }
    ]);

    return res.json({
      success: true,
      currency: "KES",
      purchases,
      totals
    });
  } catch (error) {
    console.error("Data Entry bid purchases:", error.message);
    return res.status(500).json({ success: false, message: "Could not load bid purchases." });
  }
});


/* Manual Data Entry withdrawal management */
router.get("/withdrawals", async (req, res) => {
  try {
    const filter = {};
    const allowed = [
      "pending_review", "approved", "processing",
      "reconciliation_required", "paid", "rejected"
    ];

    if (req.query.status) {
      if (!allowed.includes(req.query.status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid withdrawal status."
        });
      }
      filter.status = req.query.status;
    }

    const withdrawals = await Withdrawal.find(filter)
      .populate("userId", "name email")
      .populate("reviewedBy", "name email")
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    return res.json({
      success: true,
      currency: "USD",
      payoutCurrency: "KES",
      withdrawals
    });
  } catch (error) {
    console.error("Data Entry withdrawals:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load withdrawals."
    });
  }
});

/* Approve a request. Funds remain reserved until paid or rejected. */
router.post("/withdrawals/:requestId/approve", async (req, res) => {
  const note = typeof req.body?.adminNote === "string"
    ? req.body.adminNote.trim()
    : "";

  if (note.length > 300) {
    return res.status(400).json({
      success: false,
      message: "Admin note cannot exceed 300 characters."
    });
  }

  const session = await mongoose.startSession();

  try {
    let withdrawal;

    await session.withTransaction(async () => {
      withdrawal = await Withdrawal.findOne({
        requestId: req.params.requestId,
        status: "pending_review"
      }).session(session);

      if (!withdrawal) {
        const error = new Error("Pending withdrawal not found.");
        error.statusCode = 404;
        throw error;
      }

      withdrawal.status = "approved";
      withdrawal.reviewedBy = req.user._id;
      withdrawal.reviewedAt = new Date();
      withdrawal.adminNote = note;
      await withdrawal.save({ session });
    });

    return res.json({
      success: true,
      message: "Withdrawal approved for manual payment.",
      withdrawal
    });
  } catch (error) {
    console.error("Data Entry withdrawal approval:", error.message);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode
        ? error.message
        : "Could not approve withdrawal."
    });
  } finally {
    await session.endSession();
  }
});

/* Reject request and return reserved funds to available balance. */
router.post("/withdrawals/:requestId/reject", async (req, res) => {
  const note = typeof req.body?.adminNote === "string"
    ? req.body.adminNote.trim()
    : "";

  if (!note || note.length > 300) {
    return res.status(400).json({
      success: false,
      message: "A rejection reason of up to 300 characters is required."
    });
  }

  const session = await mongoose.startSession();

  try {
    let withdrawal;

    await session.withTransaction(async () => {
      withdrawal = await Withdrawal.findOne({
        requestId: req.params.requestId,
        status: "pending_review"
      }).session(session);

      if (!withdrawal) {
        const error = new Error("Pending withdrawal not found.");
        error.statusCode = 404;
        throw error;
      }

      const wallet = await Wallet.findOneAndUpdate(
        {
          userId: withdrawal.userId,
          reservedBalanceCents: { $gte: withdrawal.amountCents }
        },
        {
          $inc: {
            reservedBalanceCents: -withdrawal.amountCents,
            availableBalanceCents: withdrawal.amountCents
          }
        },
        { new: true, runValidators: true, session }
      );

      if (!wallet) {
        throw new Error("Reserved wallet balance is insufficient. Manual reconciliation required.");
      }

      withdrawal.status = "rejected";
      withdrawal.reviewedBy = req.user._id;
      withdrawal.reviewedAt = new Date();
      withdrawal.adminNote = note;
      await withdrawal.save({ session });
    });

    return res.json({
      success: true,
      message: "Withdrawal rejected and reserved funds released.",
      withdrawal
    });
  } catch (error) {
    console.error("Data Entry withdrawal rejection:", error.message);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode
        ? error.message
        : error.message.includes("Reserved wallet")
          ? error.message
          : "Could not reject withdrawal."
    });
  } finally {
    await session.endSession();
  }
});

/* Record a completed manual payout. This does not call Daraja. */
router.post("/withdrawals/:requestId/mark-paid", async (req, res) => {
  const receipt = typeof req.body?.mpesaReceipt === "string"
    ? req.body.mpesaReceipt.trim().toUpperCase()
    : "";
  const note = typeof req.body?.adminNote === "string"
    ? req.body.adminNote.trim()
    : "";

  if (!receipt || receipt.length > 100) {
    return res.status(400).json({
      success: false,
      message: "A valid M-Pesa receipt is required."
    });
  }

  if (note.length > 300) {
    return res.status(400).json({
      success: false,
      message: "Admin note cannot exceed 300 characters."
    });
  }

  const session = await mongoose.startSession();

  try {
    let withdrawal;

    await session.withTransaction(async () => {
      withdrawal = await Withdrawal.findOne({
        requestId: req.params.requestId,
        status: "approved"
      }).session(session);

      if (!withdrawal) {
        const error = new Error("Approved withdrawal not found.");
        error.statusCode = 404;
        throw error;
      }

      const wallet = await Wallet.findOneAndUpdate(
        {
          userId: withdrawal.userId,
          reservedBalanceCents: { $gte: withdrawal.amountCents }
        },
        {
          $inc: {
            reservedBalanceCents: -withdrawal.amountCents,
            totalWithdrawalsCents: withdrawal.amountCents
          }
        },
        { new: true, runValidators: true, session }
      );

      if (!wallet) {
        throw new Error("Reserved wallet balance is insufficient. Payment was not recorded.");
      }

      const [transaction] = await Transaction.create([{
        userId: withdrawal.userId,
        walletId: wallet._id,
        type: "withdrawal",
        amountCents: -withdrawal.amountCents,
        reference: `DATA-ENTRY-WITHDRAWAL-${withdrawal._id}`,
        description: `Manual M-Pesa withdrawal. Receipt: ${receipt}`,
        withdrawalId: withdrawal._id,
        metadata: {
          mpesaReceipt: receipt,
          payoutAmountKes: withdrawal.payoutAmountKes,
          exchangeRateKesPerUsd: withdrawal.exchangeRateKesPerUsd
        }
      }], { session });

      withdrawal.status = "paid";
      withdrawal.mpesaReceipt = receipt;
      withdrawal.walletTransactionId = transaction._id;
      if (note) withdrawal.adminNote = note;
      await withdrawal.save({ session });
    });

    return res.json({
      success: true,
      message: "Manual payout recorded and USD wallet ledger updated.",
      withdrawal
    });
  } catch (error) {
    console.error("Data Entry manual payout:", error.message);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode
        ? error.message
        : error.message.includes("Reserved wallet")
          ? error.message
          : "Could not record manual payout."
    });
  } finally {
    await session.endSession();
  }
});


/* Data Entry reports */
router.get("/reports", async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
    const to = req.query.to ? new Date(req.query.to) : new Date();

    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      from > to ||
      to - from > 366 * 86400000
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid date range. Maximum range is 366 days."
      });
    }

    to.setHours(23, 59, 59, 999);
    const range = { $gte: from, $lte: to };

    const [
      jobActivity,
      submissionActivity,
      earningActivity,
      withdrawalActivity,
      bidSalesActivity
    ] = await Promise.all([
      Order.aggregate([
        { $match: { createdAt: range } },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 }
          }
        }
      ]),
      Submission.aggregate([
        { $match: { submittedAt: range } },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 }
          }
        }
      ]),
      Transaction.aggregate([
        { $match: { createdAt: range } },
        {
          $group: {
            _id: "$type",
            count: { $sum: 1 },
            amountCents: { $sum: "$amountCents" }
          }
        }
      ]),
      Withdrawal.aggregate([
        { $match: { updatedAt: range } },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            amountCents: { $sum: "$amountCents" },
            payoutKes: { $sum: "$payoutAmountKes" }
          }
        }
      ]),
      BidPurchase.aggregate([
        {
          $match: {
            paymentStatus: "verified",
            verifiedAt: range
          }
        },
        {
          $group: {
            _id: null,
            purchases: { $sum: 1 },
            bidsSold: { $sum: "$bids" },
            revenueKes: { $sum: "$verifiedAmountKes" }
          }
        }
      ])
    ]);

    return res.json({
      success: true,
      period: {
        from: from.toISOString(),
        to: to.toISOString()
      },
      jobs: jobActivity,
      submissions: submissionActivity,
      earnings: {
        currency: "USD",
        transactions: earningActivity
      },
      withdrawals: {
        currency: "USD",
        payoutCurrency: "KES",
        records: withdrawalActivity
      },
      bidSales: {
        currency: "KES",
        ...(bidSalesActivity[0] || {
          purchases: 0,
          bidsSold: 0,
          revenueKes: 0
        })
      }
    });
  } catch (error) {
    console.error("Data Entry reports:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not generate Data Entry reports."
    });
  }
});

module.exports = router;
