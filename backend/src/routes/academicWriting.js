"use strict";

const express = require("express");
const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");
const requireAuth = require("../middleware/requireAuth");
const requireServiceAccess = require("../middleware/requireServiceAccess");
const AcademicJob = require("../models/AcademicJob");
const AcademicApplication = require("../models/AcademicApplication");
const AcademicWriterProfile = require("../models/AcademicWriterProfile");
const BidWallet = require("../models/AcademicBidWallet");
const BidTransaction = require("../models/AcademicBidTransaction");
const BidPackage = require("../models/AcademicBidPackage");
const BidPurchase = require("../models/AcademicBidPurchase");
const { initiateStkPush } = require("../services/darajaService");

const router = express.Router();
router.use(requireAuth, requireServiceAccess("academic-writing"));
router.use((req, res, next) => {
  if (req.user.role !== "user") return res.status(403).json({ success: false, message: "This marketplace area is for member accounts." });
  next();
});


router.get("/profile", async (req, res, next) => {
  try {
    const profile = await AcademicWriterProfile.findOne({
      userId: req.user._id
    }).lean();

    return res.json({
      success: true,
      profile: profile || {
        headline: "",
        bio: "",
        qualifications: "",
        experience: "",
        skills: [],
        specializations: [],
        portfolio: []
      }
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/profile", async (req, res, next) => {
  const body = req.body || {};
  const allowed = [
    "headline",
    "bio",
    "qualifications",
    "experience",
    "skills",
    "specializations",
    "portfolio"
  ];

  const submitted = Object.keys(body);

  if (!submitted.length || submitted.some(key => !allowed.includes(key))) {
    return res.status(400).json({
      success: false,
      message: "Submit at least one valid Academic Writing profile field."
    });
  }

  const updates = {};

  for (const key of ["headline", "bio", "qualifications", "experience"]) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;

    if (typeof body[key] !== "string") {
      return res.status(400).json({
        success: false,
        message: key + " must be text."
      });
    }

    const value = body[key].trim();
    const limits = {
      headline: 120,
      bio: 2000,
      qualifications: 4000,
      experience: 4000
    };

    if (value.length > limits[key]) {
      return res.status(400).json({
        success: false,
        message: key + " exceeds its maximum length of " + limits[key] + " characters."
      });
    }

    updates[key] = value;
  }

  const arrayRules = {
    skills: { max: 30, length: 80 },
    specializations: { max: 20, length: 100 },
    portfolio: { max: 10, length: 500 }
  };

  for (const [key, rule] of Object.entries(arrayRules)) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;

    if (!Array.isArray(body[key]) || body[key].length > rule.max) {
      return res.status(400).json({
        success: false,
        message: key + " must be a list containing no more than " + rule.max + " entries."
      });
    }

    const values = body[key].map(item =>
      typeof item === "string" ? item.trim() : ""
    );

    if (values.some(item => !item || item.length > rule.length)) {
      return res.status(400).json({
        success: false,
        message: "Every " + key + " entry must contain valid text of at most " + rule.length + " characters."
      });
    }

    updates[key] = [...new Set(values)];
  }

  try {
    const profile = await AcademicWriterProfile.findOneAndUpdate(
      { userId: req.user._id },
      {
        $set: updates,
        $setOnInsert: { userId: req.user._id }
      },
      {
        returnDocument: 'after',
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true
      }
    ).lean();

    return res.json({
      success: true,
      message: "Academic Writing profile saved.",
      profile
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/jobs", async (req, res, next) => {
  try {
    const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
    const limit = Math.max(1, Math.min(50, Number.parseInt(req.query.limit, 10) || 20));
    const filter = { status: "published", applicationClosesAt: { $gt: new Date() } };
    for (const key of ["discipline", "subject", "academicLevel"]) {
      if (typeof req.query[key] === "string" && req.query[key].trim()) filter[key] = req.query[key].trim().slice(0, 100);
    }
    if (req.query.q) filter.$text = { $search: String(req.query.q).slice(0, 100) };
    const [jobs, total] = await Promise.all([
      AcademicJob.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AcademicJob.countDocuments(filter)
    ]);
    return res.json({ success: true, jobs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { return next(error); }
});

router.get("/jobs/:id", async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid job ID." });
  try {
    const job = await AcademicJob.findOne({ _id: req.params.id, status: "published", applicationClosesAt: { $gt: new Date() } }).lean();
    if (!job) return res.status(404).json({ success: false, message: "Open job not found." });
    const [applicants, wallet] = await Promise.all([
      AcademicApplication.countDocuments({ jobId: job._id }),
      BidWallet.findOne({ userId: req.user._id }).select("balanceBids").lean()
    ]);
    return res.json({ success: true, job, applicants, availableBids: wallet?.balanceBids || 0 });
  } catch (error) { return next(error); }
});

router.post("/applications", async (req, res, next) => {
  const body = req.body || {};
  if (!mongoose.isValidObjectId(body.jobId)) return res.status(400).json({ success: false, message: "Valid jobId is required." });
  const skills = Array.isArray(body.skills) ? body.skills.map(x => typeof x === "string" ? x.trim().slice(0, 80) : "").filter(Boolean).slice(0, 30) : [];
  if (!Number.isSafeInteger(body.proposedPriceCents) || body.proposedPriceCents < 1 ||
      !Number.isSafeInteger(body.deliveryDays) || body.deliveryDays < 1 ||
      typeof body.coverLetter !== "string" || body.coverLetter.trim().length < 50 || body.coverLetter.length > 5000 ||
      typeof body.qualifications !== "string" || body.qualifications.trim().length < 10 || body.qualifications.length > 4000 ||
      typeof body.experience !== "string" || body.experience.trim().length < 10 || body.experience.length > 4000 ||
      !skills.length || typeof body.workApproach !== "string" || body.workApproach.trim().length < 20 || body.workApproach.length > 5000 ||
      body.availabilityConfirmed !== true || body.requirementsAccepted !== true) {
    return res.status(400).json({ success: false, message: "Complete all proposal requirements and confirm availability and project terms." });
  }
  const session = await mongoose.startSession();
  let application;
  try {
    await session.withTransaction(async () => {
      const job = await AcademicJob.findOne({ _id: body.jobId, status: "published", applicationClosesAt: { $gt: new Date() } }).session(session);
      if (!job) { const e = new Error("JOB_CLOSED"); throw e; }
      if (body.proposedPriceCents < job.budgetMinCents || body.proposedPriceCents > job.budgetMaxCents) { const e = new Error("PRICE_OUT_OF_RANGE"); throw e; }
      const already = await AcademicApplication.exists({ jobId: job._id, userId: req.user._id }).session(session);
      if (already) throw new Error("DUPLICATE_APPLICATION");
      const wallet = await BidWallet.findOneAndUpdate(
        { userId: req.user._id, balanceBids: { $gte: job.requiredBids } },
        { $inc: { balanceBids: -job.requiredBids, totalSpentBids: job.requiredBids } },
        { returnDocument: 'after', session, runValidators: true }
      );
      if (!wallet) throw new Error("INSUFFICIENT_BIDS");
      const previousBalance = wallet.balanceBids + job.requiredBids;
      [application] = await AcademicApplication.create([{
        jobId: job._id, userId: req.user._id, proposedPriceCents: body.proposedPriceCents,
        deliveryDays: body.deliveryDays, coverLetter: body.coverLetter.trim(),
        qualifications: body.qualifications.trim(), experience: body.experience.trim(), skills,
        workApproach: body.workApproach.trim(), portfolio: Array.isArray(body.portfolio) ? body.portfolio.filter(x => typeof x === "string").slice(0, 10) : [],
        availabilityConfirmed: true, requirementsAccepted: true, bidCost: job.requiredBids
      }], { session });
      await BidTransaction.create([{
        userId: req.user._id, walletId: wallet._id, type: "APPLICATION_DEDUCTION",
        bids: -job.requiredBids, previousBalance, newBalance: wallet.balanceBids,
        reference: `AW-APPLICATION-${application._id}`, description: `Application: ${job.title}`, jobId: job._id
      }], { session });
    });
    return res.status(201).json({ success: true, application, message: "Application submitted; bidding credits are not refundable for unsuccessful or withdrawn applications." });
  } catch (error) {
    const errors = { JOB_CLOSED: [409, "Applications for this job are closed."], PRICE_OUT_OF_RANGE: [400, "Proposed price must be within the listed budget range."], DUPLICATE_APPLICATION: [409, "You have already applied to this job."], INSUFFICIENT_BIDS: [409, "Insufficient bidding credits. Purchase bids before applying."] };
    if (error.code === 11000) return res.status(409).json({ success: false, message: "You have already applied to this job." });
    if (errors[error.message]) return res.status(errors[error.message][0]).json({ success: false, code: error.message, message: errors[error.message][1] });
    return next(error);
  } finally { await session.endSession(); }
});

router.get("/applications", async (req, res, next) => {
  try {
    const applications = await AcademicApplication.find({ userId: req.user._id }).populate("jobId").sort({ submittedAt: -1 }).limit(100).lean();
    return res.json({ success: true, applications });
  } catch (error) { return next(error); }
});

router.get("/bid-wallet", async (req, res, next) => {
  try {
    const [wallet, transactions] = await Promise.all([
      BidWallet.findOne({ userId: req.user._id }).lean(),
      BidTransaction.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(100).lean()
    ]);
    return res.json({ success: true, wallet: wallet || { balanceBids: 0, totalPurchasedBids: 0, totalSpentBids: 0, totalAdjustedBids: 0 }, transactions });
  } catch (error) { return next(error); }
});

router.get("/bid-packages", async (_req, res, next) => {
  try { const packages = await BidPackage.find({ isActive: true }).sort({ bids: 1 }).lean(); return res.json({ success: true, packages }); }
  catch (error) { return next(error); }
});

router.post("/bid-purchases", async (req, res, next) => {
  const packageId = req.body?.packageId;
  const phoneNumber = String(req.body?.phoneNumber || "").trim();
  const idempotencyKey = String(req.get("Idempotency-Key") || "").trim();
  if (!mongoose.isValidObjectId(packageId) || !/^254[17]\d{8}$/.test(phoneNumber) || idempotencyKey.length < 8 || idempotencyKey.length > 150) return res.status(400).json({ success: false, message: "Choose a package, provide a valid 254 M-Pesa number, and send an Idempotency-Key (8–150 characters)." });
  try {
    const existing = await BidPurchase.findOne({ userId: req.user._id, idempotencyKey });
    if (existing) {
      if (String(existing.packageId) !== String(packageId) || existing.phoneNumber !== phoneNumber) return res.status(409).json({ success: false, message: "Idempotency key was already used for different purchase details." });
      return res.json({ success: true, duplicate: true, purchase: existing });
    }
    const pkg = await BidPackage.findOne({ _id: packageId, isActive: true }).lean();
    if (!pkg) return res.status(404).json({ success: false, message: "Bid package unavailable." });
    if (await BidPurchase.exists({ userId: req.user._id, hasUnresolvedPayment: true })) return res.status(409).json({ success: false, message: "An earlier payment is unresolved; do not start another." });
    const purchase = await BidPurchase.create({ userId: req.user._id, packageId: pkg._id, packageName: pkg.name, bids: pkg.bids, expectedAmountKes: pkg.priceKes, phoneNumber, idempotencyKey });
    try {
      const stk = await initiateStkPush({ phoneNumber, amountKes: purchase.expectedAmountKes, accountReference: purchase.purchaseReference, transactionDesc: `Academic writing bids ${purchase.bids}` });
      const checkoutRequestId = stk?.checkoutRequestId || stk?.CheckoutRequestID;
      const merchantRequestId = stk?.merchantRequestId || stk?.MerchantRequestID;
      if (!checkoutRequestId || !merchantRequestId) throw new Error("STK_RESPONSE_INCOMPLETE");
      purchase.checkoutRequestId = checkoutRequestId; purchase.merchantRequestId = merchantRequestId; await purchase.save();
      return res.status(202).json({ success: true, paymentPending: true, purchase, message: "Credits are added only after independently verified M-Pesa payment." });
    } catch (error) {
      purchase.paymentStatus = "verification_required"; await purchase.save();
      console.error("Academic bid STK initiation unresolved:", error.message);
      return res.status(202).json({ success: true, paymentPending: true, purchase, message: "Payment outcome is unresolved. Do not retry before reconciliation." });
    }
  } catch (error) { return next(error); }
});

router.get("/bid-purchases", async (req, res, next) => {
  try { const purchases = await BidPurchase.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(50).lean(); return res.json({ success: true, purchases }); }
  catch (error) { return next(error); }
});

module.exports = router;