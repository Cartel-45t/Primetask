"use strict";

const express = require("express");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2;
const requireAuth = require("../middleware/requireAuth");
const Job = require("../models/TranscriptionJob");
const TranscriptionSettings = require("../models/TranscriptionSettings");
const Submission = require("../models/TranscriptionSubmission");
const Wallet = require("../models/TranscriptionWallet");
const WalletTransaction = require("../models/TranscriptionWalletTransaction");
const Withdrawal = require("../models/TranscriptionWithdrawal");
const MinutePurchase = require("../models/TranscriptionMinutePurchase");

const router = express.Router();

router.use(requireAuth);

router.use((req, res, next) => {
  if (!["admin", "founder"].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: "Administrator access required."
    });
  }
  next();
});

function validId(id) {
  return mongoose.isValidObjectId(id);
}

function transactionUnavailable(error) {
  return /transaction numbers are only allowed|replica set|mongos|does not support transactions/i
    .test(error?.message || "");
}


router.get("/overview", async (req, res) => {
  try {
    const [
      jobGroups,
      submissionGroups,
      withdrawalGroups,
      purchaseGroups,
      verifiedPurchaseTotals
    ] = await Promise.all([
      Job.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } }
      ]),
      Submission.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } }
      ]),
      Withdrawal.aggregate([
        { $group: {
          _id: "$status",
          count: { $sum: 1 },
          amountCents: { $sum: "$amountCents" }
        } }
      ]),
      MinutePurchase.aggregate([
        { $group: { _id: "$paymentStatus", count: { $sum: 1 } } }
      ]),
      MinutePurchase.aggregate([
        { $match: { paymentStatus: "verified" } },
        { $group: {
          _id: null,
          purchases: { $sum: 1 },
          minutesSold: { $sum: "$minutes" },
          revenueCents: { $sum: "$priceCents" }
        } }
      ])
    ]);

    const counts = groups => Object.fromEntries(
      groups.map(group => [group._id, group.count])
    );

    const jobs = counts(jobGroups);
    const submissions = counts(submissionGroups);
    const withdrawals = counts(withdrawalGroups);
    const purchases = counts(purchaseGroups);
    const pendingWithdrawal = withdrawalGroups.find(
      group => group._id === "pending_review"
    );
    const verified = verifiedPurchaseTotals[0] || {
      purchases: 0,
      minutesSold: 0,
      revenueCents: 0
    };

    return res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      jobs: {
        total: Object.values(jobs).reduce((sum, value) => sum + value, 0),
        byStatus: jobs
      },
      submissions: {
        total: Object.values(submissions).reduce((sum, value) => sum + value, 0),
        byStatus: submissions
      },
      withdrawals: {
        total: Object.values(withdrawals).reduce((sum, value) => sum + value, 0),
        byStatus: withdrawals,
        pendingCount: pendingWithdrawal?.count || 0,
        pendingAmountUsd: (pendingWithdrawal?.amountCents || 0) / 100
      },
      minutePurchases: {
        total: Object.values(purchases).reduce((sum, value) => sum + value, 0),
        byStatus: purchases,
        verifiedCount: verified.purchases,
        verifiedMinutesSold: verified.minutesSold,
        verifiedRevenueUsd: verified.revenueCents / 100
      }
    });
  } catch (error) {
    console.error("Admin transcription overview error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load transcription overview metrics."
    });
  }
});

router.post("/jobs", async (req, res) => {
  const {
    title,
    description,
    audioPublicId,
    instructions,
    dueAt,
    publishAt,
    rewardUsd
  } = req.body || {};

  const descriptionValue =
    typeof description === "string" ? description.trim() : "";
  const instructionsValue =
    typeof instructions === "string" ? instructions.trim() : "";
  const publicId =
    typeof audioPublicId === "string" ? audioPublicId.trim() : "";

  const suppliedTitleIsValid =
    title === undefined ||
    title === null ||
    typeof title === "string";

  const titleValue =
    typeof title === "string" ? title.trim() : "";

  if (
    !suppliedTitleIsValid ||
    titleValue.length > 180 ||
    !descriptionValue ||
    descriptionValue.length > 10000 ||
    !instructionsValue ||
    instructionsValue.length > 10000 ||
    !/^primetask-workspace\/transcription\/audio\/[A-Za-z0-9_./-]+$/.test(publicId) ||
    publicId.includes("..")
  ) {
    return res.status(400).json({
      success: false,
      message: "Provide valid job details and a protected transcription audio asset ID."
    });
  }

  let deadline;
  if (dueAt !== undefined && dueAt !== null && dueAt !== "") {
    deadline = new Date(dueAt);
    if (Number.isNaN(deadline.getTime()) || deadline <= new Date()) {
      return res.status(400).json({
        success: false,
        message: "Due date must be a valid future date."
      });
    }
  }

  let publicationDate;
  if (publishAt !== undefined && publishAt !== null && publishAt !== "") {
    publicationDate = new Date(publishAt);
    if (
      Number.isNaN(publicationDate.getTime()) ||
      publicationDate <= new Date()
    ) {
      return res.status(400).json({
        success: false,
        message: "Publication time must be a valid future date and time."
      });
    }
  }

  const hasRewardOverride =
    rewardUsd !== undefined && rewardUsd !== null && rewardUsd !== "";
  if (hasRewardOverride && (
    !Number.isSafeInteger(rewardUsd) || rewardUsd < 1 ||
    !Number.isSafeInteger(rewardUsd * 100)
  )) {
    return res.status(400).json({
      success: false,
      message: "Reward must be a positive whole USD amount."
    });
  }

  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    return res.status(503).json({
      success: false,
      message: "Audio storage is not configured on the server."
    });
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  try {
    const [asset, settings] = await Promise.all([
      cloudinary.api.resource(publicId, {
        resource_type: "video",
        type: "authenticated"
      }),
      TranscriptionSettings.findOne({ key: "transcription" })
    ]);

    if (
      asset.resource_type !== "video" ||
      asset.type !== "authenticated" ||
      asset.public_id !== publicId ||
      !["mp3", "wav", "m4a", "ogg", "flac", "webm"].includes(
        String(asset.format || "").toLowerCase()
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "The selected asset is not a supported protected audio file."
      });
    }

    const durationSeconds = Number(asset.duration);

    if (
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0
    ) {
      return res.status(422).json({
        success: false,
        message: "Cloudinary did not provide a verifiable audio duration. The job was not created."
      });
    }

    const durationMinutes = Math.ceil(durationSeconds / 60);

    if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 1) {
      return res.status(422).json({
        success: false,
        message: "The verified audio duration is invalid."
      });
    }

    let configuredRewardUsd;

    if (!hasRewardOverride) {
      if (!settings) {
        return res.status(503).json({
          success: false,
          message: "Transcription settings are required when no custom reward is supplied."
        });
      }

      const ranges = Array.isArray(settings.durationRewardRanges)
        ? settings.durationRewardRanges
        : [];

      const matchingRanges = ranges.filter(range =>
        durationMinutes >= range.minMinutes &&
        durationMinutes <= range.maxMinutes
      );

      if (matchingRanges.length !== 1) {
        return res.status(422).json({
          success: false,
          message: "No unique reward rule matches this audio duration. Update the admin duration and reward settings."
        });
      }

      configuredRewardUsd = matchingRanges[0].rewardUsd;
    }

    const finalRewardUsd = hasRewardOverride
      ? rewardUsd
      : configuredRewardUsd;
    const rewardCents = finalRewardUsd * 100;

    if (
      !Number.isSafeInteger(finalRewardUsd) ||
      finalRewardUsd < 1 ||
      !Number.isSafeInteger(rewardCents)
    ) {
      return res.status(500).json({
        success: false,
        message: "The matching reward rule is invalid. The job was not created."
      });
    }

    const finalTitle = titleValue ||
      (settings && settings.defaultAudioTitle) ||
      "Transcription Task";

    if (!finalTitle || finalTitle.length > 180) {
      return res.status(400).json({
        success: false,
        message: "Provide a valid job title or configure a default title."
      });
    }

    const job = await Job.create({
      title: finalTitle,
      description: descriptionValue,
      audioAssetUrl: null,
      audioPublicId: publicId,
      durationMinutes,
      rewardCents,
      instructions: instructionsValue,
      status: "open",
      assignedUserId: null,
      createdByAdminId: req.user._id,
      ...(deadline ? { dueAt: deadline } : {}),
      ...(publicationDate ? { publishAt: publicationDate } : {})
    });

    return res.status(201).json({
      success: true,
      message: publicationDate && publicationDate > new Date()
        ? "Transcription job scheduled using verified audio duration and reward."
        : "Transcription job created using verified audio duration and reward.",
      job: {
        id: String(job._id),
        title: job.title,
        durationMinutes: job.durationMinutes,
        reward: job.rewardCents / 100,
        currency: "USD",
        status: job.publishAt && job.publishAt > new Date() ? "scheduled" : job.status,
        publishAt: job.publishAt || null,
        dueAt: job.dueAt || null,
        createdAt: job.createdAt
      }
    });
  } catch (error) {
    if (error.http_code === 404 || error.http_code === 400) {
      return res.status(400).json({
        success: false,
        message: "The protected audio asset could not be verified."
      });
    }

    console.error("Admin transcription job creation error:", error.message);
    return res.status(502).json({
      success: false,
      message: "Could not verify the audio asset or create the job."
    });
  }
});



/*
 * GET /api/admin/transcription/jobs/:id/audio
 * Admin-only streaming proxy for a verified authenticated Cloudinary asset.
 * Never returns the temporary Cloudinary URL to the browser.
 */
router.get("/jobs", async (req, res) => {
  try {
    const now = new Date();
    const jobs = await Job.find({})
      .sort({ createdAt: -1, _id: -1 })
      .limit(500)
      .lean();

    return res.json({
      success: true,
      jobs: jobs.map(job => ({
        id: String(job._id),
        title: job.title,
        description: job.description,
        instructions: job.instructions,
        durationMinutes: job.durationMinutes,
        reward: Number((job.rewardCents / 100).toFixed(2)),
        currency: "USD",
        status: job.status === "open" && job.publishAt && job.publishAt > now
          ? "scheduled"
          : job.status,
        dueAt: job.dueAt || null,
        publishAt: job.publishAt || null,
        assignedUserId: job.assignedUserId ? String(job.assignedUserId) : null,
        claimedAt: job.claimedAt || null,
        assignmentExpiresAt: job.assignmentExpiresAt || null,
        createdAt: job.createdAt
      }))
    });
  } catch (error) {
    console.error("Admin transcription job register error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load transcription jobs."
    });
  }
});

router.get("/jobs/:id/audio", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid job ID."
    });
  }

  const allowedFormats = new Set([
    "mp3", "wav", "m4a", "ogg", "flac", "webm"
  ]);
  const audioMimeTypes = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    flac: "audio/flac",
    webm: "audio/webm"
  };

  try {
    if (
      !process.env.CLOUDINARY_CLOUD_NAME ||
      !process.env.CLOUDINARY_API_KEY ||
      !process.env.CLOUDINARY_API_SECRET
    ) {
      return res.status(503).json({
        success: false,
        message: "Audio storage is not configured."
      });
    }

    const job = await Job.findById(req.params.id)
      .select("audioPublicId")
      .lean();

    if (!job || !job.audioPublicId) {
      return res.status(404).json({
        success: false,
        message: "Audio is not available for this job."
      });
    }

    const publicId = job.audioPublicId;
    if (
      typeof publicId !== "string" ||
      !/^primetask-workspace\/transcription\/audio\/[A-Za-z0-9_./-]+$/.test(publicId) ||
      publicId.includes("..")
    ) {
      console.error("Invalid transcription audio asset reference.");
      return res.status(502).json({
        success: false,
        message: "The job audio could not be verified."
      });
    }

    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });

    const asset = await cloudinary.api.resource(publicId, {
      resource_type: "video",
      type: "authenticated"
    });

    const format = String(asset.format || "").toLowerCase();
    if (
      asset.public_id !== publicId ||
      asset.resource_type !== "video" ||
      asset.type !== "authenticated" ||
      !allowedFormats.has(format)
    ) {
      return res.status(502).json({
        success: false,
        message: "The job audio could not be verified."
      });
    }

    const signedUrl = cloudinary.utils.private_download_url(
      publicId,
      format,
      {
        resource_type: "video",
        type: "authenticated",
        expires_at: Math.floor(Date.now() / 1000) + 60
      }
    );

    const downloadUrl = new URL(signedUrl);
    if (
      downloadUrl.protocol !== "https:" ||
      downloadUrl.hostname !== "api.cloudinary.com"
    ) {
      throw new Error("Unexpected Cloudinary download URL.");
    }

    const upstreamHeaders = {};
    if (req.headers.range) {
      upstreamHeaders.Range = req.headers.range;
    }

    const upstream = await fetch(downloadUrl, {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "error"
    });

    if (![200, 206, 416].includes(upstream.status)) {
      await upstream.body?.cancel().catch(() => {});
      console.error("Admin audio stream returned status:", upstream.status);
      return res.status(502).json({
        success: false,
        message: "Audio playback is temporarily unavailable."
      });
    }

    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Type", audioMimeTypes[format]);

    for (const header of ["content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(header);
      if (value) {
        res.setHeader(
          header.split("-").map(part =>
            part.charAt(0).toUpperCase() + part.slice(1)
          ).join("-"),
          value
        );
      }
    }

    if (upstream.status === 416) {
      await upstream.body?.cancel().catch(() => {});
      return res.status(416).end();
    }

    if (!upstream.body) {
      return res.status(502).json({
        success: false,
        message: "Audio playback is temporarily unavailable."
      });
    }

    res.status(upstream.status);
    require("node:stream").Readable.fromWeb(upstream.body)
      .on("error", error => {
        console.error("Admin audio stream error:", error.message);
        res.destroy(error);
      })
      .pipe(res);
  } catch (error) {
    if (error.http_code === 404 || error.statusCode === 404) {
      return res.status(404).json({
        success: false,
        message: "Audio is not available for this job."
      });
    }

    console.error("Admin transcription audio playback error:", error.message);
    if (!res.headersSent) {
      return res.status(502).json({
        success: false,
        message: "Audio playback is temporarily unavailable."
      });
    }
    return res.destroy(error);
  }
});

/*
 * GET /api/admin/transcription/submissions/:id/document
 * Authenticated admin/founder only. Never expose the Cloudinary URL.
 */
router.get("/submissions/:id/document", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid submission ID."
    });
  }

  try {
    const submission = await Submission.findById(req.params.id)
      .select("documentPublicId documentFormat documentOriginalName")
      .lean();

    if (
      !submission ||
      submission.documentFormat !== "docx" ||
      typeof submission.documentPublicId !== "string" ||
      !/^primetask-workspace\/transcription\/documents\/[A-Za-z0-9_./-]+$/.test(
        submission.documentPublicId
      ) ||
      submission.documentPublicId.includes("..")
    ) {
      return res.status(404).json({
        success: false,
        message: "DOCX document not found."
      });
    }

    if (
      !process.env.CLOUDINARY_CLOUD_NAME ||
      !process.env.CLOUDINARY_API_KEY ||
      !process.env.CLOUDINARY_API_SECRET
    ) {
      return res.status(503).json({
        success: false,
        message: "Document storage is not configured."
      });
    }

    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });

    const publicId = submission.documentPublicId;
    const asset = await cloudinary.api.resource(publicId, {
      resource_type: "raw",
      type: "authenticated"
    });

    if (
      asset.public_id !== publicId ||
      asset.resource_type !== "raw" ||
      asset.type !== "authenticated" ||
      asset.format !== "docx"
    ) {
      return res.status(404).json({
        success: false,
        message: "DOCX document not found."
      });
    }

    const signedUrl = cloudinary.utils.private_download_url(
      publicId,
      "docx",
      {
        resource_type: "raw",
        type: "authenticated",
        expires_at: Math.floor(Date.now() / 1000) + 60
      }
    );

    const parsedUrl = new URL(signedUrl);
    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.hostname !== "api.cloudinary.com" ||
      parsedUrl.username ||
      parsedUrl.password
    ) {
      throw new Error("Unexpected document download URL.");
    }

    const upstream = await fetch(parsedUrl.href, {
      method: "GET",
      redirect: "error"
    });

    if (!upstream.ok) {
      return res.status(502).json({
        success: false,
        message: "The DOCX document could not be retrieved."
      });
    }

    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) {
      return res.status(502).json({
        success: false,
        message: "The retrieved DOCX document has an invalid size."
      });
    }

    const originalName = typeof submission.documentOriginalName === "string"
      ? submission.documentOriginalName
      : "";
    const filename = (originalName.split(/[\\/]/).pop() || "submission.docx")
      .replace(/[^A-Za-z0-9._ -]/g, "_")
      .replace(/^[. ]+/, "")
      .slice(-150) || "submission.docx";

    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    });

    return res.status(200).send(bytes);
  } catch (error) {
    console.error("Admin transcription document download error:", error.message);
    return res.status(502).json({
      success: false,
      message: "The DOCX document is temporarily unavailable."
    });
  }
});

/* GET /api/admin/transcription/submissions */
router.get("/submissions", async (req, res) => {
  try {
    const status = String(req.query.status || "submitted");
    const allowed = ["submitted", "approved", "rejected"];

    if (!allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid submission status."
      });
    }

    const submissions = await Submission.find({ status })
      .populate("userId", "username firstName lastName email")
      .populate("jobId", "title durationMinutes rewardCents status")
      .sort({ createdAt: 1 })
      .limit(100)
      .lean();

    return res.json({
      success: true,
      submissions: submissions.map(item => ({
        id: String(item._id),
        transcriptText: item.transcriptText,
        submissionLink: item.submissionLink || "",
        documentAvailable: Boolean(
          item.documentFormat === "docx" &&
          typeof item.documentPublicId === "string" &&
          item.documentPublicId.startsWith(
            "primetask-workspace/transcription/documents/"
          ) &&
          !item.documentPublicId.includes("..")
        ),
        documentOriginalName: item.documentOriginalName || "",
        documentBytes: item.documentBytes || null,
        status: item.status,
        reviewNote: item.reviewNote,
        reward: item.rewardCents / 100,
        currency: "USD",
        createdAt: item.createdAt,
        user: item.userId ? {
          id: String(item.userId._id),
          username: item.userId.username,
          firstName: item.userId.firstName,
          lastName: item.userId.lastName,
          email: item.userId.email
        } : null,
        job: item.jobId ? {
          id: String(item.jobId._id),
          title: item.jobId.title,
          durationMinutes: item.jobId.durationMinutes,
          reward: item.jobId.rewardCents / 100,
          status: item.jobId.status
        } : null
      }))
    });
  } catch (error) {
    console.error("Admin transcription submissions error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load transcription submissions."
    });
  }
});

/*
 * PATCH /api/admin/transcription/submissions/:id/review
 *
 * Body:
 * { "decision": "approve", "reviewNote": "..." }
 * or
 * { "decision": "reject", "reviewNote": "..." }
 *
 * Approval, ledger entry, wallet credit and job completion are atomic.
 */
router.patch("/submissions/:id/review", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid submission ID."
    });
  }

  const decision = req.body?.decision;
  const reviewNote = typeof req.body?.reviewNote === "string"
    ? req.body.reviewNote.trim()
    : "";

  if (!["approve", "reject"].includes(decision)) {
    return res.status(400).json({
      success: false,
      message: 'Decision must be "approve" or "reject".'
    });
  }

  if (reviewNote.length > 2000) {
    return res.status(400).json({
      success: false,
      message: "Review note cannot exceed 2,000 characters."
    });
  }

  if (decision === "reject" && !reviewNote) {
    return res.status(400).json({
      success: false,
      message: "Provide a review note explaining the rejection."
    });
  }

  let session;

  try {
    session = await mongoose.startSession();
    let result;

    await session.withTransaction(async () => {
      const submission = await Submission.findOne({
        _id: req.params.id,
        status: "submitted"
      }).session(session);

      if (!submission) {
        const error = new Error(
          "Submission was already reviewed or does not exist."
        );
        error.statusCode = 409;
        throw error;
      }

      const job = await Job.findOne({
        _id: submission.jobId,
        status: "submitted",
        assignedUserId: submission.userId
      }).session(session);

      if (!job) {
        const error = new Error(
          "The associated job is not awaiting review."
        );
        error.statusCode = 409;
        throw error;
      }

      if (decision === "reject") {
        const reviewedAt = new Date();

        submission.reviewHistory.push({
          decision: "rejected",
          reviewNote,
          reviewedBy: req.user._id,
          reviewedAt
        });

        submission.status = "rejected";
        submission.reviewNote = reviewNote;
        submission.reviewedBy = req.user._id;
        submission.reviewedAt = reviewedAt;
        await submission.save({ session });

        // Keep the same submission record so the worker can revise it.
        // The unique job/user index remains intact.
        job.status = "awarded";
        await job.save({ session });

        result = {
          decision,
          submissionId: String(submission._id),
          jobId: String(job._id),
          status: "rejected",
          credited: 0,
          currency: "USD"
        };
        return;
      }

      const wallet = await Wallet.findOneAndUpdate(
        { userId: submission.userId },
        { $setOnInsert: { userId: submission.userId } },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
          session
        }
      );

      const reference = `TRANSCRIPTION-EARNING-${submission._id}`;

      // Unique submission index plus the transaction prevents a
      // second credit for the same approved submission.
      const [ledgerEntry] = await WalletTransaction.create([{
        userId: submission.userId,
        type: "earning",
        amountCents: submission.rewardCents,
        currency: "USD",
        status: "completed",
        reference,
        description: `Approved transcription: ${job.title}`,
        transcriptionSubmissionId: submission._id
      }], { session });

      const creditedWallet = await Wallet.findOneAndUpdate(
        {
          _id: wallet._id,
          userId: submission.userId,
          availableBalanceCents: { $lte: Number.MAX_SAFE_INTEGER - submission.rewardCents },
          totalEarningsCents: { $lte: Number.MAX_SAFE_INTEGER - submission.rewardCents }
        },
        {
          $inc: {
            availableBalanceCents: submission.rewardCents,
            totalEarningsCents: submission.rewardCents
          }
        },
        { new: true, session }
      );

      if (!creditedWallet) {
        throw new Error("Wallet credit would exceed safe balance limits.");
      }

      const reviewedAt = new Date();

      submission.reviewHistory.push({
        decision: "approved",
        reviewNote,
        reviewedBy: req.user._id,
        reviewedAt
      });

      submission.status = "approved";
      submission.reviewNote = reviewNote;
      submission.reviewedBy = req.user._id;
      submission.reviewedAt = reviewedAt;
      submission.walletTransactionId = ledgerEntry._id;
      await submission.save({ session });

      job.status = "completed";
      job.completedAt = new Date();
      await job.save({ session });

      result = {
        decision,
        submissionId: String(submission._id),
        jobId: String(job._id),
        status: "approved",
        credited: submission.rewardCents / 100,
        currency: "USD",
        walletBalance: creditedWallet.availableBalanceCents / 100
      };
    });

    return res.json({
      success: true,
      message: decision === "approve"
        ? "Submission approved and transcription earnings credited."
        : "Submission rejected. The worker may revise and resubmit this job; no earnings were credited.",
      result
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "A duplicate earnings entry was prevented. Check the submission and wallet before retrying."
      });
    }

    if (transactionUnavailable(error)) {
      return res.status(503).json({
        success: false,
        message: "MongoDB transaction support is required. No review changes were committed."
      });
    }

    console.error("Transcription review error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not review this submission."
    });
  } finally {
    if (session) await session.endSession();
  }
});



// List transcription withdrawals for authorized administrators.
router.get("/withdrawals", async (req, res) => {
  try {
    const allowed = new Set(["pending_review", "paid", "rejected"]);
    const status = String(req.query.status || "pending_review");

    if (!allowed.has(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid withdrawal status."
      });
    }

    const withdrawals = await Withdrawal.find({ status })
      .populate("userId", "username email")
      .sort({ createdAt: 1 })
      .lean();

    return res.json({
      success: true,
      withdrawals: withdrawals.map((item) => ({
        id: String(item._id),
        requestId: item.requestId,
        user: item.userId
          ? {
              id: String(item.userId._id),
              username: item.userId.username,
              email: item.userId.email
            }
          : null,
        amount: item.amountCents / 100,
        currency: "USD",
        phoneNumber: item.phoneNumber,
        status: item.status,
        mpesaReceipt: item.mpesaReceipt || null,
        reviewNote: item.reviewNote || "",
        createdAt: item.createdAt,
        reviewedAt: item.reviewedAt
      }))
    });
  } catch (error) {
    console.error("Transcription withdrawal list error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load transcription withdrawals."
    });
  }
});

// Record an actual, manually completed M-Pesa payout or reject and refund.
// This endpoint does not initiate a Daraja payment.
router.patch("/withdrawals/:id/review", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid withdrawal ID."
    });
  }

  const decision = String(req.body?.decision || "").trim().toLowerCase();
  const mpesaReceipt = String(req.body?.mpesaReceipt || "")
    .trim()
    .toUpperCase();
  const reviewNote = String(req.body?.reviewNote || "").trim();

  if (!["paid", "reject"].includes(decision)) {
    return res.status(400).json({
      success: false,
      message: "Decision must be paid or reject."
    });
  }

  if (decision === "paid" && !/^[A-Z0-9]{8,20}$/.test(mpesaReceipt)) {
    return res.status(400).json({
      success: false,
      message: "Provide a valid M-Pesa receipt reference."
    });
  }

  if (decision === "reject" && !reviewNote) {
    return res.status(400).json({
      success: false,
      message: "A reason is required when rejecting a withdrawal."
    });
  }

  let session;

  try {
    session = await mongoose.startSession();
    let result;

    await session.withTransaction(async () => {
      const withdrawal = await Withdrawal.findOneAndUpdate(
        {
          _id: req.params.id,
          status: "pending_review"
        },
        {
          $set: {
            status: decision === "paid" ? "paid" : "rejected",
            reviewedBy: req.user._id,
            reviewedAt: new Date(),
            reviewNote,
            ...(decision === "paid" ? { mpesaReceipt } : {})
          }
        },
        { new: true, session, runValidators: true }
      );

      if (!withdrawal) {
        const error = new Error(
          "Withdrawal was not found or has already been reviewed."
        );
        error.statusCode = 409;
        throw error;
      }

      const ledger = await WalletTransaction.findOne({
        transcriptionWithdrawalId: withdrawal._id,
        userId: withdrawal.userId,
        type: "withdrawal",
        status: "pending"
      }).session(session);

      if (!ledger || ledger.amountCents !== withdrawal.amountCents) {
        const error = new Error(
          "Matching pending withdrawal ledger entry is missing or inconsistent."
        );
        error.statusCode = 409;
        throw error;
      }

      ledger.status = decision === "paid" ? "completed" : "failed";
      await ledger.save({ session });

      if (decision === "paid") {
        const wallet = await Wallet.findOneAndUpdate(
          {
            userId: withdrawal.userId,
            totalWithdrawalsCents: {
              $lte: Number.MAX_SAFE_INTEGER - withdrawal.amountCents
            }
          },
          {
            $inc: { totalWithdrawalsCents: withdrawal.amountCents }
          },
          { new: true, session }
        );

        if (!wallet) {
          throw new Error(
            "Transcription wallet missing or withdrawal total exceeds safe limits."
          );
        }
      } else {
        const wallet = await Wallet.findOneAndUpdate(
          {
            userId: withdrawal.userId,
            availableBalanceCents: {
              $lte: Number.MAX_SAFE_INTEGER - withdrawal.amountCents
            }
          },
          {
            $inc: { availableBalanceCents: withdrawal.amountCents }
          },
          { new: true, session }
        );

        if (!wallet) {
          throw new Error(
            "Transcription wallet missing or refund exceeds safe balance limits."
          );
        }
      }

      result = {
        withdrawalId: String(withdrawal._id),
        status: withdrawal.status,
        amount: withdrawal.amountCents / 100,
        currency: "USD",
        mpesaReceipt: withdrawal.mpesaReceipt || null
      };
    });

    return res.json({
      success: true,
      message: decision === "paid"
        ? "Withdrawal marked paid. This records a manually completed payment; no Daraja payment was initiated."
        : "Withdrawal rejected and funds returned to the transcription wallet.",
      result
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "This M-Pesa receipt is already recorded."
      });
    }

    if (transactionUnavailable(error)) {
      return res.status(503).json({
        success: false,
        message: "MongoDB transaction support is required. No review changes were committed."
      });
    }

    console.error("Transcription withdrawal review error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not review this withdrawal."
    });
  } finally {
    if (session) await session.endSession();
  }
});


module.exports = router;
