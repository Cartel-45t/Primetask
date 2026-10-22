"use strict";

const express = require("express");
const multer = require("multer");
const { Readable } = require("node:stream");
const validateDocx = require("../services/validateDocx");
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2;
const requireAuth = require("../middleware/requireAuth");
const requireServiceAccess = require("../middleware/requireServiceAccess");
const TranscriptionJob = require("../models/TranscriptionJob");
const TranscriptionSubmission = require("../models/TranscriptionSubmission");

const router = express.Router();

router.use(requireAuth);

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

const ASSIGNMENT_WINDOW_MS = 60 * 60 * 1000;

async function releaseExpiredAssignments() {
  const now = new Date();

  await TranscriptionJob.updateMany(
    {
      status: "awarded",
      $or: [
        { assignmentExpiresAt: { $lte: now } },
        { assignmentExpiresAt: null },
        { claimedAt: null }
      ]
    },
    {
      $set: {
        status: "open",
        assignedUserId: null,
        claimedAt: null,
        assignmentExpiresAt: null
      }
    }
  );
}

function publicJob(job) {
  return {
    id: String(job._id),
    title: job.title,
    description: job.description,
    durationMinutes: job.durationMinutes,
    reward: Number((job.rewardCents / 100).toFixed(2)),
    currency: "USD",
    instructions: job.instructions,
    status: job.status,
    publishAt: job.publishAt || null,
    dueAt: job.dueAt,
    claimedAt: job.claimedAt || null,
    assignmentExpiresAt: job.assignmentExpiresAt || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}


/*
 * GET /api/transcription/jobs/:id/audio
 *
 * Streams protected audio only to the worker assigned to the job.
 * Cloudinary's temporary signed URL stays on the backend.
 */
router.get("/jobs/:id/audio", async (req, res) => {
  if (!isValidId(req.params.id)) {
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

    const job = await TranscriptionJob.findOne({
      _id: req.params.id,
      assignedUserId: req.user._id,
      status: { $in: ["awarded", "submitted", "completed"] },
      $or: [
        { status: { $in: ["submitted", "completed"] } },
        {
          status: "awarded",
          claimedAt: { $ne: null },
          assignmentExpiresAt: { $gt: new Date() }
        }
      ]
    }).lean();

    // Do not reveal whether a different worker's job exists.
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

    // Reject unexpected URL destinations before making an outbound request.
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
      console.error("Cloudinary audio stream returned status:", upstream.status);
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

    for (const header of [
      "content-length",
      "content-range",
      "accept-ranges"
    ]) {
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

    const { Readable } = require("node:stream");
    Readable.fromWeb(upstream.body).on("error", error => {
      console.error("Transcription audio stream error:", error.message);
      if (!res.headersSent) {
        res.status(502);
      }
      res.destroy(error);
    }).pipe(res);
  } catch (error) {
    if (error.http_code === 404 || error.statusCode === 404) {
      return res.status(404).json({
        success: false,
        message: "Audio is not available for this job."
      });
    }

    console.error("Transcription audio playback error:", error.message);

    if (!res.headersSent) {
      return res.status(502).json({
        success: false,
        message: "Audio playback is temporarily unavailable."
      });
    }

    return res.destroy(error);
  }
});

/* GET /api/transcription/jobs */
router.get("/jobs", async (req, res) => {
  try {
    await releaseExpiredAssignments();

    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = {
      status: "open",
      $and: [{ $or: [
        { publishAt: null },
        { publishAt: { $exists: false } },
        { publishAt: { $lte: new Date() } }
      ] }]
    };

    const [jobs, total] = await Promise.all([
      TranscriptionJob.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      TranscriptionJob.countDocuments(filter)
    ]);

    return res.json({
      success: true,
      page,
      limit,
      total,
      jobs: jobs.map(publicJob)
    });
  } catch (error) {
    console.error("Transcription job listing error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not load available transcription jobs."
    });
  }
});

/* GET /api/transcription/jobs/:id */
router.get("/jobs/:id", async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid job ID." });
  }

  try {
    await releaseExpiredAssignments();

    const job = await TranscriptionJob.findOne({
      _id: req.params.id,
      status: { $in: ["open", "awarded", "submitted", "completed", "closed"] }
    }).lean();

    if (!job) {
      return res.status(404).json({ success: false, message: "Job not found." });
    }

    const isAssigned = job.assignedUserId &&
      String(job.assignedUserId) === String(req.user._id);

    const isAdmin = ["admin", "founder", "superadmin"].includes(req.user.role);
    if (
      !isAdmin &&
      (
        (job.status !== "open" && !isAssigned) ||
        (job.status === "open" && job.publishAt && job.publishAt > new Date())
      )
    ) {
      return res.status(404).json({ success: false, message: "Job not found." });
    }

    return res.json({ success: true, job: publicJob(job) });
  } catch (error) {
    console.error("Transcription job detail error:", error.message);
    return res.status(500).json({ success: false, message: "Could not load this job." });
  }
});

/* POST /api/transcription/jobs/:id/claim */
router.post("/jobs/:id/claim", requireServiceAccess("transcription"), async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid job ID." });
  }

  try {
    await releaseExpiredAssignments();

    const claimedAt = new Date();
    const assignmentExpiresAt = new Date(
      claimedAt.getTime() + ASSIGNMENT_WINDOW_MS
    );

    const job = await TranscriptionJob.findOneAndUpdate(
      {
        _id: req.params.id,
        status: "open",
        assignedUserId: null,
        $or: [
          { publishAt: null },
          { publishAt: { $exists: false } },
          { publishAt: { $lte: claimedAt } }
        ]
      },
      {
        $set: {
          status: "awarded",
          assignedUserId: req.user._id,
          claimedAt,
          assignmentExpiresAt
        }
      },
      { new: true, runValidators: true }
    );

    if (!job) {
      return res.status(409).json({
        success: false,
        message: "This job is no longer available."
      });
    }

    return res.json({ success: true, message: "Job awarded to your account.", job: publicJob(job) });
  } catch (error) {
    console.error("Transcription claim error:", error.message);
    return res.status(500).json({ success: false, message: "Could not claim this job." });
  }
});

/* GET /api/transcription/my-jobs */
router.get("/my-jobs", async (req, res) => {
  try {
    await releaseExpiredAssignments();

    const jobs = await TranscriptionJob.find({
      assignedUserId: req.user._id
    }).sort({ updatedAt: -1 }).limit(100).lean();

    return res.json({ success: true, jobs: jobs.map(publicJob) });
  } catch (error) {
    console.error("Transcription assigned jobs error:", error.message);
    return res.status(500).json({ success: false, message: "Could not load your awarded jobs." });
  }
});


/*
 * Worker submissions accept exactly one of:
 * - JSON transcriptText
 * - multipart/form-data document (.docx)
 *
 * DOCX files are validated in memory and stored as authenticated Cloudinary
 * raw assets. Temporary signed download URLs are never returned to clients.
 */
const submissionUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
    fields: 5,
    fieldSize: 250 * 1024
  },
  fileFilter(req, file, callback) {
    const isDocxName = /\.docx$/i.test(file.originalname || "");
    const allowedMimeTypes = new Set([
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/octet-stream"
    ]);

    if (!isDocxName || !allowedMimeTypes.has(file.mimetype)) {
      return callback(new Error("UNSUPPORTED_DOCX_TYPE"));
    }

    callback(null, true);
  }
});

function cloudinaryDocumentStorageReady() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

function uploadSubmissionDocument(buffer) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      folder: "primetask-workspace/transcription/documents",
      resource_type: "raw",
      type: "authenticated",
      format: "docx",
      use_filename: false,
      unique_filename: true,
      overwrite: false
    }, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });

    Readable.from(buffer).pipe(stream);
  });
}

async function deleteSubmissionDocument(publicId) {
  if (
    typeof publicId !== "string" ||
    !/^primetask-workspace\/transcription\/documents\/[A-Za-z0-9_./-]+$/.test(publicId) ||
    publicId.includes("..")
  ) {
    return;
  }

  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: "raw",
      type: "authenticated",
      invalidate: true
    });
  } catch (error) {
    console.error("Transcription document cleanup error:", error.message);
  }
}

router.post(
  "/jobs/:id/submissions",
  requireServiceAccess("transcription"),
  (req, res, next) => {
    submissionUpload.single("document")(req, res, error => {
      if (!error) return next();

      if (error instanceof multer.MulterError) {
        const message = error.code === "LIMIT_FILE_SIZE"
          ? "DOCX documents must be 10 MB or smaller."
          : error.code === "LIMIT_UNEXPECTED_FILE"
            ? 'Upload one DOCX file using the "document" field.'
            : "The document upload exceeded an allowed limit.";

        return res.status(400).json({ success: false, message });
      }

      return res.status(400).json({
        success: false,
        message: error.message === "UNSUPPORTED_DOCX_TYPE"
          ? "Upload a .docx Word document with a supported MIME type."
          : "The document upload could not be processed."
      });
    });
  },
  async (req, res) => {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid job ID."
      });
    }

    const transcriptText = typeof req.body?.transcriptText === "string"
      ? req.body.transcriptText.trim()
      : "";

    const hasText = transcriptText.length > 0;
    const hasDocument = Boolean(req.file);
    const submissionLink = typeof req.body?.submissionLink === "string"
      ? req.body.submissionLink.trim()
      : "";

    if (submissionLink) {
      let parsedLink;
      try {
        parsedLink = new URL(submissionLink);
      } catch {
        return res.status(400).json({
          success: false,
          message: "Provide a valid HTTPS submission link."
        });
      }

      if (
        parsedLink.protocol !== "https:" ||
        !parsedLink.hostname ||
        parsedLink.username ||
        parsedLink.password ||
        submissionLink.length > 2048
      ) {
        return res.status(400).json({
          success: false,
          message: "Submission link must be a valid HTTPS URL, no longer than 2048 characters, without embedded credentials."
        });
      }
    }

    if (hasText === hasDocument) {
      return res.status(400).json({
        success: false,
        message: "Provide either transcriptText or one DOCX document, not both."
      });
    }

    if (hasText && transcriptText.length > 200000) {
      return res.status(400).json({
        success: false,
        message: "Transcript text cannot exceed 200,000 characters."
      });
    }

    let documentMetadata = null;

    if (hasDocument) {
      if (!cloudinaryDocumentStorageReady()) {
        return res.status(503).json({
          success: false,
          message: "Document storage is not configured."
        });
      }

      try {
        await validateDocx(req.file.buffer);

        documentMetadata = {
          originalName: req.file.originalname
            .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
            .slice(-255),
          bytes: req.file.size
        };
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: "The uploaded file is not a valid supported DOCX document."
        });
      }
    }

    let uploadedPublicId = null;
    let oldPublicId = null;
    let submissionSaved = false;

    try {
      await releaseExpiredAssignments();

      const eligibleJob = await TranscriptionJob.findOne({
        _id: req.params.id,
        assignedUserId: req.user._id,
        status: "awarded",
        claimedAt: { $ne: null },
        assignmentExpiresAt: { $gt: new Date() }
      }).select("_id rewardCents claimedAt assignmentExpiresAt");

      if (!eligibleJob) {
        return res.status(409).json({
          success: false,
          message: "You must hold an awarded job that is available for submission."
        });
      }

      const existing = await TranscriptionSubmission.findOne({
        jobId: eligibleJob._id,
        userId: req.user._id
      }).select("_id status documentPublicId");

      if (existing && existing.status !== "rejected") {
        return res.status(409).json({
          success: false,
          message: "This job already has a submission that cannot be revised."
        });
      }

      if (hasDocument) {
        const uploaded = await uploadSubmissionDocument(req.file.buffer);

        console.error("[DOCX Cloudinary response metadata]", {
          resource_type: uploaded.resource_type,
          type: uploaded.type,
          public_id: uploaded.public_id,
          format: uploaded.format,
          asset_folder: uploaded.asset_folder,
          bytes: uploaded.bytes
        });

        if (
          uploaded.resource_type !== "raw" ||
          uploaded.type !== "authenticated" ||
          typeof uploaded.public_id !== "string" ||
          !uploaded.public_id.startsWith(
            "primetask-workspace/transcription/documents/"
          ) ||
          uploaded.public_id.includes("..") ||
          uploaded.format !== "docx"
        ) {
          if (uploaded.public_id) {
            await deleteSubmissionDocument(uploaded.public_id);
          }

          throw new Error("Cloudinary returned an unexpected document configuration.");
        }

        uploadedPublicId = uploaded.public_id;
      }

      const content = {
        transcriptText: hasText ? transcriptText : "",
        submissionLink,
        documentPublicId: uploadedPublicId,
        documentOriginalName: documentMetadata?.originalName || "",
        documentBytes: documentMetadata?.bytes || null,
        documentFormat: hasDocument ? "docx" : null
      };

      let submissionResponse = null;
      let isRevision = false;
      const session = await mongoose.startSession();

      try {
        await session.withTransaction(async () => {
          // Reset values because MongoDB may retry the transaction callback.
          oldPublicId = null;
          submissionResponse = null;
          isRevision = false;

          const claimedJob = await TranscriptionJob.findOneAndUpdate(
            {
              _id: eligibleJob._id,
              assignedUserId: req.user._id,
              status: "awarded",
              claimedAt: { $ne: null },
              assignmentExpiresAt: { $gt: new Date() }
            },
            {
              $set: {
                status: "submitted",
                assignmentExpiresAt: null
              }
            },
            { new: true, session }
          );

          if (!claimedJob) {
            const error = new Error(
              "This job changed while you were submitting. Please refresh and check its status."
            );
            error.statusCode = 409;
            throw error;
          }

          const submission = await TranscriptionSubmission.findOne({
            jobId: claimedJob._id,
            userId: req.user._id
          }).session(session);

          if (submission) {
            if (submission.status !== "rejected") {
              const error = new Error("This submission cannot be revised.");
              error.statusCode = 409;
              throw error;
            }

            oldPublicId = submission.documentPublicId || null;
            submission.set({
              ...content,
              status: "submitted",
              reviewNote: "",
              reviewedBy: null,
              reviewedAt: null,
              walletTransactionId: null,
              revisionCount: (submission.revisionCount || 0) + 1
            });

            await submission.save({ session });
            isRevision = true;

            submissionResponse = {
              id: String(submission._id),
              jobId: String(submission.jobId),
              status: submission.status,
              contentType: hasDocument ? "docx" : "text",
              revisionCount: submission.revisionCount || 0,
              reward: Number((submission.rewardCents / 100).toFixed(2)),
              currency: "USD",
              createdAt: submission.createdAt
            };
          } else {
            const [created] = await TranscriptionSubmission.create([{
              jobId: claimedJob._id,
              userId: req.user._id,
              ...content,
              rewardCents: claimedJob.rewardCents
            }], { session });

            submissionResponse = {
              id: String(created._id),
              jobId: String(created.jobId),
              status: created.status,
              contentType: hasDocument ? "docx" : "text",
              revisionCount: created.revisionCount || 0,
              reward: Number((created.rewardCents / 100).toFixed(2)),
              currency: "USD",
              createdAt: created.createdAt
            };
          }
        });
      } finally {
        await session.endSession();
      }

      submissionSaved = true;

      // Remove an old revision document only after the transaction commits.
      if (oldPublicId && oldPublicId !== uploadedPublicId) {
        await deleteSubmissionDocument(oldPublicId);
      }

      return res.status(201).json({
        success: true,
        message: isRevision
          ? "Revised transcript submitted for review."
          : hasDocument
            ? "DOCX transcript submitted for review."
            : "Transcript submitted for review.",
        submission: submissionResponse
      });
    } catch (error) {
      if (uploadedPublicId && !submissionSaved) {
        // Never delete an upload if its database reference cannot be ruled out.
        let safeToDelete = false;

        try {
          const reference = await TranscriptionSubmission.exists({
            documentPublicId: uploadedPublicId
          });
          safeToDelete = !reference;
        } catch (checkError) {
          console.error(
            "Could not verify transcription document references:",
            checkError.message
          );
        }

        if (safeToDelete) {
          await deleteSubmissionDocument(uploadedPublicId);
        } else {
          console.error(
            "Retained uploaded document because its database reference could not be ruled out."
          );
        }
      }

      if (error.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message
        });
      }

      if (error.code === 11000) {
        return res.status(409).json({
          success: false,
          message: "A submission already exists for this job."
        });
      }

      if (
        /transaction numbers are only allowed|replica set|mongos|does not support transactions/i
          .test(error?.message || "")
      ) {
        return res.status(503).json({
          success: false,
          message: "MongoDB transaction support is required. No submission was confirmed."
        });
      }

      console.error("Transcription submission error:", error.message);

      return res.status(500).json({
        success: false,
        message: "Could not submit this transcript. Check the job status before retrying."
      });
    }
  }
);

/* GET /api/transcription/submissions */
router.get("/submissions", async (req, res) => {
  try {
    const submissions = await TranscriptionSubmission.find({
      userId: req.user._id
    }).sort({ createdAt: -1 }).limit(100).lean();

    return res.json({
      success: true,
      submissions: submissions.map(item => ({
        id: String(item._id),
        jobId: String(item.jobId),
        status: item.status,
        reviewNote: item.reviewNote,
        reward: Number((item.rewardCents / 100).toFixed(2)),
        currency: "USD",
        createdAt: item.createdAt,
        reviewedAt: item.reviewedAt
      }))
    });
  } catch (error) {
    console.error("Transcription submissions error:", error.message);
    return res.status(500).json({ success: false, message: "Could not load your submissions." });
  }
});

module.exports = router;
