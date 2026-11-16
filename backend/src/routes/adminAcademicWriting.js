"use strict";

const express = require("express");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const requireAuth = require("../middleware/requireAuth");
const Job = require("../models/AcademicJob");
const Application = require("../models/AcademicApplication");
const BidPackage = require("../models/AcademicBidPackage");
const BidWallet = require("../models/AcademicBidWallet");
const BidTransaction = require("../models/AcademicBidTransaction");
const AdminAuditLog = require("../models/AdminAuditLog");

const router = express.Router();
router.use(requireAuth, (req, res, next) => {
  if (!["admin", "founder"].includes(req.user.role)) return res.status(403).json({ success: false, message: "Administrator access is required." });
  next();
});
router.use(rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false, message: { success: false, message: "Too many Academic Writing admin requests." } }));

function jobInput(body, partial = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const fields = ["title", "description", "discipline", "subject", "academicLevel", "serviceCategory", "skills", "qualifications", "scope", "wordCount", "referencingStyle", "deliverables", "budgetMinCents", "budgetMaxCents", "requiredBids", "applicationClosesAt", "deadline", "successfulApplicants", "instructions"];
  const keys = Object.keys(body);
  if (!keys.length || keys.some(key => !fields.includes(key)) || (!partial && fields.slice(0, 6).some(key => !keys.includes(key)))) return null;
  const textFields = ["title", "description", "discipline", "subject", "academicLevel", "serviceCategory", "scope", "referencingStyle", "instructions"];
  for (const key of textFields) if (key in body && (typeof body[key] !== "string" || !body[key].trim() || body[key].length > (key === "description" ? 12000 : 5000))) return null;
  for (const key of ["budgetMinCents", "budgetMaxCents", "requiredBids", "successfulApplicants"]) if (key in body && (!Number.isSafeInteger(body[key]) || body[key] < 1)) return null;
  if ("wordCount" in body && body.wordCount !== null && (!Number.isSafeInteger(body.wordCount) || body.wordCount < 1)) return null;
  for (const key of ["skills", "qualifications", "deliverables"]) if (key in body && (!Array.isArray(body[key]) || body[key].length > 30 || !body[key].every(item => typeof item === "string" && item.trim().length && item.length <= 120))) return null;
  for (const key of ["applicationClosesAt", "deadline"]) if (key in body && Number.isNaN(new Date(body[key]).getTime())) return null;
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, typeof value === "string" ? value.trim() : Array.isArray(value) ? value.map(item => item.trim()) : value]));
}

router.get("/overview", async (_req, res, next) => {
  try {
    const [jobs, applications, wallets] = await Promise.all([
      Job.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Application.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      BidWallet.aggregate([{ $group: { _id: null, available: { $sum: "$balanceBids" }, sold: { $sum: "$totalPurchasedBids" }, used: { $sum: "$totalSpentBids" } } }])
    ]);
    return res.json({ success: true, jobs: Object.fromEntries(jobs.map(x => [x._id, x.count])), applications: Object.fromEntries(applications.map(x => [x._id, x.count])), bids: wallets[0] || { available: 0, sold: 0, used: 0 }, completedProjects: 0, approvedEarningsCents: 0, pendingWithdrawals: 0, note: "Academic Writing earnings and withdrawals are not enabled until verified project-funding and payout flows exist." });
  } catch (error) { return next(error); }
});

router.get("/jobs", async (_req, res, next) => {
  try { const jobs = await Job.find({}).sort({ createdAt: -1 }).limit(200).lean(); return res.json({ success: true, jobs }); }
  catch (error) { return next(error); }
});

router.post("/jobs", async (req, res, next) => {
  const input = jobInput(req.body);
  if (!input) return res.status(400).json({ success: false, message: "Invalid job fields; provide required title, description, discipline, subject, level and category." });
  try {
    const job = await Job.create({ ...input, createdBy: req.user._id, status: "draft" });
    await AdminAuditLog.create({ adminId: req.user._id, targetUserId: req.user._id, action: "academic_job_created", reason: `Created academic job ${job._id}`, after: { jobId: String(job._id), status: job.status }, ipAddress: String(req.ip || "").slice(0, 100) });
    return res.status(201).json({ success: true, job });
  } catch (error) { return next(error); }
});

router.patch("/jobs/:id", async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid job ID." });
  const input = jobInput(req.body, true);
  if (!input) return res.status(400).json({ success: false, message: "Invalid job changes." });
  try {
    const before = await Job.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ success: false, message: "Job not found." });
    if (["closed", "archived"].includes(before.status)) return res.status(409).json({ success: false, message: "Closed or archived jobs cannot be edited." });
    const job = await Job.findByIdAndUpdate(req.params.id, { $set: input }, { new: true, runValidators: true });
    await AdminAuditLog.create({ adminId: req.user._id, targetUserId: req.user._id, action: "academic_job_updated", reason: `Updated academic job ${job._id}`, before: { status: before.status }, after: { status: job.status, fields: Object.keys(input) }, ipAddress: String(req.ip || "").slice(0, 100) });
    return res.json({ success: true, job });
  } catch (error) { return next(error); }
});

router.patch("/jobs/:id/status", async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id) || !["published", "paused", "closed", "archived"].includes(req.body?.status)) return res.status(400).json({ success: false, message: "Invalid job ID or status." });
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ success: false, message: "Job not found." });
    if (job.status === "draft" && req.body.status === "published") job.publishedAt = new Date();
    const before = job.status; job.status = req.body.status; await job.save();
    await AdminAuditLog.create({ adminId: req.user._id, targetUserId: req.user._id, action: "academic_job_status_changed", reason: `Changed academic job ${job._id} from ${before} to ${job.status}`, before: { status: before }, after: { status: job.status }, ipAddress: String(req.ip || "").slice(0, 100) });
    return res.json({ success: true, job });
  } catch (error) { return next(error); }
});

router.get("/applications", async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.jobId && mongoose.isValidObjectId(req.query.jobId)) filter.jobId = req.query.jobId;
    if (["submitted", "under_review", "shortlisted", "awarded", "unsuccessful", "withdrawn"].includes(req.query.status)) filter.status = req.query.status;
    const applications = await Application.find(filter).populate("jobId").populate("userId", "firstName lastName username email").sort({ submittedAt: -1 }).limit(200).lean();
    return res.json({ success: true, applications });
  } catch (error) { return next(error); }
});

router.patch("/applications/:id/status", async (req, res, next) => {
  const { status, note } = req.body || {};
  if (!mongoose.isValidObjectId(req.params.id) || !["under_review", "shortlisted", "unsuccessful"].includes(status) || (note !== undefined && (typeof note !== "string" || note.length > 2000))) return res.status(400).json({ success: false, message: "Invalid application status update." });
  try {
    const app = await Application.findById(req.params.id);
    if (!app) return res.status(404).json({ success: false, message: "Application not found." });
    if (["awarded", "withdrawn", "unsuccessful"].includes(app.status)) return res.status(409).json({ success: false, message: "This application is already in a terminal state." });
    const before = app.status; app.status = status; app.reviewedBy = req.user._id; app.reviewedAt = new Date(); app.reviewNote = String(note || "").trim(); await app.save();
    await AdminAuditLog.create({ adminId: req.user._id, targetUserId: app.userId, action: `academic_application_${status}`, reason: `Changed application ${app._id} from ${before} to ${status}`, before: { status: before }, after: { status, note: app.reviewNote }, ipAddress: String(req.ip || "").slice(0, 100) });
    return res.json({ success: true, application: app });
  } catch (error) { return next(error); }
});

router.post("/applications/:id/award", async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid application ID." });
  const session = await mongoose.startSession();
  try {
    let application;
    await session.withTransaction(async () => {
      application = await Application.findById(req.params.id).session(session);
      if (!application || !["submitted", "under_review", "shortlisted"].includes(application.status)) throw new Error("APPLICATION_NOT_AWARDABLE");
      const job = await Job.findOneAndUpdate(
        { _id: application.jobId, status: { $in: ["published", "paused"] }, $expr: { $lt: ["$awardedCount", "$successfulApplicants"] } },
        { $inc: { awardedCount: 1 } },
        { new: true, session }
      );
      if (!job) throw new Error("AWARD_LIMIT_REACHED");
      application.status = "awarded"; application.reviewedBy = req.user._id; application.reviewedAt = new Date(); await application.save({ session });
      if (job.awardedCount >= job.successfulApplicants) { job.status = "closed"; await job.save({ session }); }
      await AdminAuditLog.create([{ adminId: req.user._id, targetUserId: application.userId, action: "academic_application_awarded", reason: `Awarded application ${application._id} for job ${job._id}`, before: { status: "shortlisted" }, after: { status: "awarded", proposedPriceCents: application.proposedPriceCents }, ipAddress: String(req.ip || "").slice(0, 100) }], { session });
    });
    return res.json({ success: true, application });
  } catch (error) {
    if (error.message === "APPLICATION_NOT_AWARDABLE") return res.status(409).json({ success: false, message: "Application cannot be awarded." });
    if (error.message === "JOB_NOT_AWARDABLE" || error.message === "AWARD_LIMIT_REACHED") return res.status(409).json({ success: false, message: "Job is closed or has reached its successful applicant limit." });
    return next(error);
  } finally { await session.endSession(); }
});

router.get("/bid-packages", async (_req, res, next) => {
  try { return res.json({ success: true, packages: await BidPackage.find({}).sort({ createdAt: -1 }).limit(200).lean() }); }
  catch (error) { return next(error); }
});

router.post("/bid-packages", async (req, res, next) => {
  const { name, description = "", bids, priceKes, isActive = true } = req.body || {};
  if (typeof name !== "string" || !name.trim() || name.length > 120 || typeof description !== "string" || description.length > 500 || !Number.isSafeInteger(bids) || bids < 1 || !Number.isSafeInteger(priceKes) || priceKes < 1 || typeof isActive !== "boolean") return res.status(400).json({ success: false, message: "Provide valid package name, description, whole bid count, KSh price and active flag." });
  try {
    const pack = await BidPackage.create({ name: name.trim(), description: description.trim(), bids, priceKes, isActive, createdBy: req.user._id });
    await AdminAuditLog.create({ adminId: req.user._id, targetUserId: req.user._id, action: "academic_bid_package_created", reason: `Created Academic Writing bid package ${pack._id}`, after: { name: pack.name, bids: pack.bids, priceKes: pack.priceKes, isActive: pack.isActive }, ipAddress: String(req.ip || "").slice(0, 100) });
    return res.status(201).json({ success: true, package: pack });
  }
  catch (error) { return next(error); }
});

router.patch("/bid-packages/:id", async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid package ID." });
  const allowed = ["name", "description", "bids", "priceKes", "isActive"];
  if (!req.body || !Object.keys(req.body).length || Object.keys(req.body).some(k => !allowed.includes(k))) return res.status(400).json({ success: false, message: "Unsupported package fields." });
  try {
    const before = await BidPackage.findById(req.params.id).lean();
    const pack = await BidPackage.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true, runValidators: true });
    if (!pack) return res.status(404).json({ success: false, message: "Package not found." });
    await AdminAuditLog.create({ adminId: req.user._id, targetUserId: req.user._id, action: "academic_bid_package_updated", reason: `Updated Academic Writing bid package ${pack._id}`, before: before ? { name: before.name, bids: before.bids, priceKes: before.priceKes, isActive: before.isActive } : null, after: { name: pack.name, bids: pack.bids, priceKes: pack.priceKes, isActive: pack.isActive }, ipAddress: String(req.ip || "").slice(0, 100) });
    return res.json({ success: true, package: pack });
  }
  catch (error) { return next(error); }
});

router.post("/bid-wallets/:userId/adjust", async (req, res, next) => {
  const { bids, reason } = req.body || {};
  if (!mongoose.isValidObjectId(req.params.userId) || !Number.isSafeInteger(bids) || bids === 0 || Math.abs(bids) > 100000 || typeof reason !== "string" || reason.trim().length < 8 || reason.length > 500) return res.status(400).json({ success: false, message: "Provide a valid user, non-zero whole bid adjustment and audit reason (8–500 characters)." });
  const session = await mongoose.startSession();
  try {
    let wallet;
    await session.withTransaction(async () => {
      const query = { userId: req.params.userId };
      if (bids < 0) query.balanceBids = { $gte: Math.abs(bids) };
      wallet = await BidWallet.findOneAndUpdate(query, { $setOnInsert: { userId: req.params.userId }, $inc: { balanceBids: bids, totalAdjustedBids: bids } }, { new: true, upsert: bids > 0, setDefaultsOnInsert: true, runValidators: true, session });
      if (!wallet) throw new Error("INSUFFICIENT_BIDS");
      await BidTransaction.create([{ userId: req.params.userId, walletId: wallet._id, type: bids > 0 ? "ADMIN_CREDIT" : "ADMIN_DEBIT", bids, previousBalance: wallet.balanceBids - bids, newBalance: wallet.balanceBids, reference: `AW-ADMIN-${req.user._id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, description: reason.trim(), metadata: { adminId: String(req.user._id) } }], { session });
      await AdminAuditLog.create([{ adminId: req.user._id, targetUserId: req.params.userId, action: bids > 0 ? "academic_bid_credit" : "academic_bid_debit", reason: reason.trim(), after: { bids, balance: wallet.balanceBids }, ipAddress: String(req.ip || "").slice(0, 100) }], { session });
    });
    return res.json({ success: true, wallet });
  } catch (error) { if (error.message === "INSUFFICIENT_BIDS") return res.status(409).json({ success: false, message: "Adjustment would make the wallet balance negative." }); return next(error); }
  finally { await session.endSession(); }
});

router.get("/bid-transactions", async (req, res, next) => {
  try { const filter = {}; if (req.query.userId && mongoose.isValidObjectId(req.query.userId)) filter.userId = req.query.userId; const transactions = await BidTransaction.find(filter).populate("userId", "username email firstName lastName").sort({ createdAt: -1 }).limit(200).lean(); return res.json({ success: true, transactions }); }
  catch (error) { return next(error); }
});

module.exports = router;