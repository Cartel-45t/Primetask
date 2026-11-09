"use strict";

const express = require("express");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const cloudinary = require("cloudinary").v2;
const ExcelJS = require("exceljs");
const { Readable } = require("node:stream");

const requireAuth = require("../middleware/requireAuth");
const requireServiceAccess = require("../middleware/requireServiceAccess");

const DataEntryOrder = require("../models/DataEntryOrder");
const DataEntryBidWallet = require("../models/DataEntryBidWallet");
const DataEntryWallet = require("../models/DataEntryWallet");
const DataEntryBidTransaction = require("../models/DataEntryBidTransaction");
const DataEntrySubmission = require("../models/DataEntrySubmission");

const router = express.Router();

router.use(requireAuth);
router.use(requireServiceAccess("data-entry"));

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

/*
 * Expired assignments return to the published list.
 * Bids are deliberately NOT refunded under the selected policy.
 *
 * The status and deadline conditions prevent a submitted job from
 * being released, and make concurrent expiry requests safe.
 */
async function releaseExpiredAssignments() {
  const now = new Date();

  const result = await DataEntryOrder.updateMany(
    {
      status: "assigned",
      assignmentExpiresAt: { $type: "date", $lte: now },
      claimedAt: { $type: "date" },
      assignedUserId: { $type: "objectId" }
    },
    {
      $set: {
        status: "published",
        assignedUserId: null,
        claimedAt: null,
        assignmentExpiresAt: null,
        submittedAt: null
      }
    }
  );

  return result.modifiedCount || 0;
}

/*
 * GET /api/data-entry/jobs
 * Lists currently published jobs after releasing expired assignments.
 */

/*
 * GET /api/data-entry/dashboard
 * Worker-only overview. Earnings are read from the separate
 * Data Entry USD wallet, never from the bid or main PTW wallet.
 */
router.get("/dashboard", async (req, res) => {
  try {
    await releaseExpiredAssignments();

    const userId = req.user._id;

    const [
      availableJobs,
      activeJobs,
      completedJobs,
      wallet,
      submissions
    ] = await Promise.all([
      DataEntryOrder.countDocuments({
        status: "published"
      }),

      DataEntryOrder.countDocuments({
        assignedUserId: userId,
        status: {
          $in: ["assigned", "submitted", "revision_requested"]
        }
      }),

      DataEntryOrder.countDocuments({
        assignedUserId: userId,
        status: "completed"
      }),

      DataEntryWallet.findOne({ userId })
        .select("totalEarningsCents")
        .lean(),

      DataEntrySubmission.find({ userId })
        .select(
          "_id orderTitle status submittedAt reviewedAt reviewNote reviewHistory"
        )
        .sort({ submittedAt: -1 })
        .limit(5)
        .lean()
    ]);

    const recentActivity = submissions.map(item => {
      const history = Array.isArray(item.reviewHistory)
        ? item.reviewHistory
        : [];

      const latestReview = history.length
        ? history[history.length - 1]
        : null;

      return {
        _id: item._id,
        title: item.orderTitle,
        status: item.status,
        submittedAt: item.submittedAt,
        reviewedAt: item.reviewedAt,
        reviewNote: item.reviewNote || latestReview?.reviewNote || ""
      };
    });

    return res.json({
      success: true,
      stats: {
        availableJobs,
        activeJobs,
        completedJobs,
        earningsCents: wallet?.totalEarningsCents || 0
      },
      recentActivity
    });
  } catch (error) {
    console.error("Data Entry worker dashboard error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not load the Data Entry dashboard."
    });
  }
});

router.get("/jobs", async (req, res) => {
  try {
    await releaseExpiredAssignments();

    const [jobs, bidWallet] = await Promise.all([
      DataEntryOrder.find({ status: "published" })
        .select(
          "_id title description category instructions rewardCents requiredBids timeLimitMinutes acceptedFileFormats publishedAt createdAt"
        )
        .sort({ publishedAt: -1, createdAt: -1 })
        .lean(),

      DataEntryBidWallet.findOne({ userId: req.user._id })
        .select("balanceBids")
        .lean()
    ]);

    return res.json({
      success: true,
      jobs,
      bidBalance: bidWallet?.balanceBids || 0
    });
  } catch (error) {
    console.error("Data Entry available jobs error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not load available Data Entry jobs."
    });
  }
});

/*
 * POST /api/data-entry/jobs/:id/claim
 *
 * Bid deduction, assignment and ledger entry are committed together.
 * A failed assignment rolls back the bid deduction.
 */
router.post("/jobs/:id/claim", async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid Data Entry job ID."
    });
  }

  const session = await mongoose.startSession();

  try {
    await releaseExpiredAssignments();

    let claimedJob = null;
    let resultingBalance = null;

    await session.withTransaction(async () => {
      const job = await DataEntryOrder.findOne({
        _id: req.params.id,
        status: "published"
      }).session(session);

      if (!job) {
        const error = new Error("JOB_UNAVAILABLE");
        error.code = "JOB_UNAVAILABLE";
        throw error;
      }

      const bidCost = job.requiredBids;

      await DataEntryBidWallet.findOneAndUpdate(
        { userId: req.user._id },
        {
          $setOnInsert: {
            userId: req.user._id
          }
        },
        {
          upsert: true,
          new: true,
          session,
          setDefaultsOnInsert: true
        }
      );

      const wallet = await DataEntryBidWallet.findOneAndUpdate(
        {
          userId: req.user._id,
          balanceBids: { $gte: bidCost }
        },
        {
          $inc: {
            balanceBids: -bidCost,
            totalSpentBids: bidCost
          }
        },
        {
          new: true,
          session,
          runValidators: true
        }
      );

      if (!wallet) {
        const error = new Error("INSUFFICIENT_BIDS");
        error.code = "INSUFFICIENT_BIDS";
        throw error;
      }

      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + job.timeLimitMinutes * 60 * 1000
      );

      const updatedJob = await DataEntryOrder.findOneAndUpdate(
        {
          _id: job._id,
          status: "published"
        },
        {
          $set: {
            status: "assigned",
            assignedUserId: req.user._id,
            claimedAt: now,
            assignmentExpiresAt: expiresAt,
            submittedAt: null
          }
        },
        {
          new: true,
          session,
          runValidators: true
        }
      );

      if (!updatedJob) {
        const error = new Error("JOB_UNAVAILABLE");
        error.code = "JOB_UNAVAILABLE";
        throw error;
      }

      await DataEntryBidTransaction.create(
        [{
          userId: req.user._id,
          walletId: wallet._id,
          type: "job_claim",
          bids: -bidCost,
          reference: `DATA-ENTRY-CLAIM-${job._id}-${crypto.randomUUID()}`,
          orderId: job._id,
          description: `Bids charged to claim Data Entry job: ${job.title}`,
          metadata: {
            timeLimitMinutes: job.timeLimitMinutes,
            claimedAt: now.toISOString(),
            assignmentExpiresAt: expiresAt.toISOString(),
            expiryPolicy: "No bid refund for expired assignments."
          }
        }],
        { session }
      );

      claimedJob = updatedJob;
      resultingBalance = wallet.balanceBids;
    });

    return res.json({
      success: true,
      message: "Data Entry job claimed successfully.",
      job: {
        _id: claimedJob._id,
        title: claimedJob.title,
        description: claimedJob.description,
        category: claimedJob.category,
        instructions: claimedJob.instructions,
        rewardCents: claimedJob.rewardCents,
        requiredBids: claimedJob.requiredBids,
        timeLimitMinutes: claimedJob.timeLimitMinutes,
        acceptedFileFormats: claimedJob.acceptedFileFormats,
        claimedAt: claimedJob.claimedAt,
        assignmentExpiresAt: claimedJob.assignmentExpiresAt
      },
      bidWallet: {
        balanceBids: resultingBalance
      }
    });
  } catch (error) {
    if (error.code === "JOB_UNAVAILABLE") {
      return res.status(409).json({
        success: false,
        code: "JOB_UNAVAILABLE",
        message: "This job is no longer available. Refresh the jobs list."
      });
    }

    if (error.code === "INSUFFICIENT_BIDS") {
      return res.status(409).json({
        success: false,
        code: "INSUFFICIENT_BIDS",
        message: "You do not have enough Data Entry bids to claim this job."
      });
    }

    console.error("Data Entry job claim error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not claim this Data Entry job."
    });
  } finally {
    await session.endSession();
  }
});

/*
 * GET /api/data-entry/my-jobs
 * Lists the authenticated worker's active and historical assignments.
 */
router.get("/my-jobs", async (req, res) => {
  try {
    await releaseExpiredAssignments();

    const jobs = await DataEntryOrder.find({
      assignedUserId: req.user._id,
      status: { $in: ["assigned", "submitted", "revision_requested", "completed"] }
    })
      .select(
        "_id title description category instructions rewardCents requiredBids timeLimitMinutes acceptedFileFormats status claimedAt assignmentExpiresAt submittedAt completedAt"
      )
      .sort({ updatedAt: -1 })
      .lean();

    return res.json({
      success: true,
      jobs
    });
  } catch (error) {
    console.error("Data Entry my jobs error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not load your Data Entry jobs."
    });
  }
});


/*
 * Data Entry XLSX/CSV submission uploads.
 * Files are authenticated raw Cloudinary assets tied to one worker and order.
 */
const DATA_ENTRY_DOCUMENT_FOLDER =
  "primetask-workspace/data-entry/submissions";
const DATA_ENTRY_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

function dataEntryCloudinaryReady() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

function configureDataEntryCloudinary() {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

function dataEntryDocumentFormat(name) {
  if (typeof name !== "string") return null;
  const match = name.trim().match(/\.(xlsx|csv)$/i);
  return match ? match[1].toLowerCase() : null;
}

function expectedDataEntryPublicId(value) {
  return typeof value === "string" &&
    /^primetask-workspace\/data-entry\/submissions\/[0-9a-f-]{36}\.(xlsx|csv)$/i.test(value);
}

async function validateDataEntryFile(buffer, format) {
  if (!Buffer.isBuffer(buffer) ||
      buffer.length < 1 ||
      buffer.length > DATA_ENTRY_MAX_DOCUMENT_BYTES) {
    throw new Error("The uploaded file has an invalid size.");
  }

  if (format === "xlsx") {
    // XLSX is a ZIP-based Office Open XML workbook.
    if (
      buffer.length < 4 ||
      buffer[0] !== 0x50 ||
      buffer[1] !== 0x4b ||
      buffer[2] !== 0x03 ||
      buffer[3] !== 0x04
    ) {
      throw new Error("The uploaded file is not a valid XLSX workbook.");
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    if (!workbook.worksheets.length) {
      throw new Error("The XLSX workbook must contain at least one worksheet.");
    }

    return;
  }

  if (format === "csv") {
    let csvText;

    try {
      csvText = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error("The CSV file must use valid UTF-8 text.");
    }

    if (!csvText.trim() || csvText.includes("\u0000")) {
      throw new Error("The CSV file is empty or contains invalid characters.");
    }

    // Parse the CSV instead of accepting arbitrary text with a .csv filename.
    const workbook = new ExcelJS.Workbook();
    await workbook.csv.read(Readable.from([buffer]));

    if (!workbook.worksheets.length ||
        workbook.worksheets[0].rowCount < 1) {
      throw new Error("The CSV file does not contain readable rows.");
    }

    return;
  }

  throw new Error("Only XLSX and CSV files are accepted.");
}

async function getVerifiedDataEntryDocument(
  publicId,
  userId,
  orderId,
  expectedFormat
) {
  if (!expectedDataEntryPublicId(publicId) ||
      !["xlsx", "csv"].includes(expectedFormat)) {
    throw new Error("Invalid Data Entry document reference.");
  }

  configureDataEntryCloudinary();

  const asset = await cloudinary.api.resource(publicId, {
    resource_type: "raw",
    type: "authenticated"
  });

  const bytes = Number(asset.bytes);
  const custom = asset.context?.custom || {};

  if (
    asset.public_id !== publicId ||
    asset.resource_type !== "raw" ||
    asset.type !== "authenticated" ||
    String(asset.format || "").toLowerCase() !== expectedFormat ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > DATA_ENTRY_MAX_DOCUMENT_BYTES ||
    String(custom.ptw_user_id || "") !== String(userId) ||
    String(custom.ptw_job_id || "") !== String(orderId)
  ) {
    throw new Error("Cloudinary Data Entry document verification failed.");
  }

  const url = cloudinary.utils.private_download_url(
    publicId,
    expectedFormat,
    {
      resource_type: "raw",
      type: "authenticated",
      expires_at: Math.floor(Date.now() / 1000) + 120
    }
  );

  const parsed = new URL(url);

  if (
    parsed.protocol !== "https:" ||
    !["api.cloudinary.com", "res.cloudinary.com"].includes(parsed.hostname)
  ) {
    throw new Error("Cloudinary returned an unexpected download URL.");
  }

  const response = await fetch(parsed.href);

  if (!response.ok) {
    throw new Error("Could not retrieve the uploaded Data Entry document.");
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length !== bytes) {
    throw new Error("The uploaded document size does not match Cloudinary metadata.");
  }

  await validateDataEntryFile(buffer, expectedFormat);

  return { asset, buffer, bytes };
}

/*
 * POST /api/data-entry/jobs/:id/submissions/document-signature
 * Authorizes one authenticated XLSX or CSV upload.
 */
router.post("/jobs/:id/submissions/document-signature", async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid Data Entry order ID."
    });
  }

  if (!dataEntryCloudinaryReady()) {
    return res.status(503).json({
      success: false,
      message: "Data Entry document storage is not configured."
    });
  }

  const originalName = typeof req.body?.originalName === "string"
    ? req.body.originalName.trim()
    : "";

  const size = Number(req.body?.size);
  const format = dataEntryDocumentFormat(originalName);

  if (
    !format ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > DATA_ENTRY_MAX_DOCUMENT_BYTES
  ) {
    return res.status(400).json({
      success: false,
      message: "Choose an XLSX or CSV file no larger than 10 MB."
    });
  }

  try {
    await releaseExpiredAssignments();

    const order = await DataEntryOrder.findOne({
      _id: req.params.id,
      assignedUserId: req.user._id,
      $or: [
        {
          status: "assigned",
          claimedAt: { $ne: null },
          assignmentExpiresAt: { $gt: new Date() }
        },
        { status: "revision_requested" }
      ]
    }).select("_id acceptedFileFormats");

    if (!order) {
      return res.status(409).json({
        success: false,
        message: "You do not hold an active assignment that accepts submissions."
      });
    }

    if (!order.acceptedFileFormats.map(value => value.toLowerCase()).includes(format)) {
      return res.status(400).json({
        success: false,
        message: `This order does not accept ${format.toUpperCase()} files.`
      });
    }

    const existing = await DataEntrySubmission.findOne({
      orderId: order._id,
      userId: req.user._id
    }).select("_id status");

    if (existing && existing.status !== "revision_requested") {
      return res.status(409).json({
        success: false,
        message: "This submission cannot receive another upload."
      });
    }

    configureDataEntryCloudinary();

    const timestamp = Math.floor(Date.now() / 1000);
    const publicId =
      `${DATA_ENTRY_DOCUMENT_FOLDER}/${crypto.randomUUID()}.${format}`;

    const params = {
      timestamp,
      public_id: publicId,
      type: "authenticated",
      overwrite: false,
      allowed_formats: format,
      context:
        `ptw_user_id=${String(req.user._id)}|ptw_job_id=${String(order._id)}`
    };

    const signature = cloudinary.utils.api_sign_request(
      params,
      process.env.CLOUDINARY_API_SECRET
    );

    return res.json({
      success: true,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      signature,
      params,
      format
    });
  } catch (error) {
    console.error("Data Entry upload signature error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Could not authorize the Data Entry document upload."
    });
  }
});

/*
 * POST /api/data-entry/jobs/:id/submissions
 * Creates a submission or resubmits an existing revision-requested record.
 */
router.post("/jobs/:id/submissions", async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid Data Entry order ID."
    });
  }

  const submissionText = typeof req.body?.submissionText === "string"
    ? req.body.submissionText.trim()
    : "";

  const submissionLink = typeof req.body?.submissionLink === "string"
    ? req.body.submissionLink.trim()
    : "";

  const documentPublicId =
    typeof req.body?.documentPublicId === "string"
      ? req.body.documentPublicId.trim()
      : "";

  const documentOriginalName =
    typeof req.body?.documentOriginalName === "string"
      ? req.body.documentOriginalName.trim()
      : "";

  if (submissionText.length > 200000) {
    return res.status(400).json({
      success: false,
      message: "Submission text cannot exceed 200,000 characters."
    });
  }

  if (submissionLink) {
    let parsed;

    try {
      parsed = new URL(submissionLink);
    } catch {
      return res.status(400).json({
        success: false,
        message: "Provide a valid HTTPS submission link."
      });
    }

    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      submissionLink.length > 2048
    ) {
      return res.status(400).json({
        success: false,
        message: "Submission link must be a valid HTTPS URL without embedded credentials."
      });
    }
  }

  const hasDocument = Boolean(documentPublicId || documentOriginalName);

  if (
    hasDocument &&
    (!documentPublicId ||
      !documentOriginalName ||
      !expectedDataEntryPublicId(documentPublicId))
  ) {
    return res.status(400).json({
      success: false,
      message: "The uploaded document reference is invalid."
    });
  }

  if (!submissionText && !submissionLink && !documentPublicId) {
    return res.status(400).json({
      success: false,
      message: "Submit text, an HTTPS link or an XLSX/CSV document."
    });
  }

  const format = hasDocument
    ? dataEntryDocumentFormat(documentOriginalName)
    : null;

  if (hasDocument && !format) {
    return res.status(400).json({
      success: false,
      message: "Only XLSX and CSV documents are accepted."
    });
  }

  let verifiedDocument = null;

  try {
    await releaseExpiredAssignments();

    const order = await DataEntryOrder.findOne({
      _id: req.params.id,
      assignedUserId: req.user._id,
      $or: [
        {
          status: "assigned",
          claimedAt: { $ne: null },
          assignmentExpiresAt: { $gt: new Date() }
        },
        { status: "revision_requested" }
      ]
    }).select("_id title rewardCents acceptedFileFormats");

    if (!order) {
      return res.status(409).json({
        success: false,
        message: "Your assignment has expired or is not available for submission."
      });
    }

    const existing = await DataEntrySubmission.findOne({
      orderId: order._id,
      userId: req.user._id
    }).select("_id status documentPublicId revisionCount");

    if (existing && existing.status !== "revision_requested") {
      return res.status(409).json({
        success: false,
        message: "This order already has a submission that cannot be revised."
      });
    }

    if (hasDocument) {
      if (!order.acceptedFileFormats.map(value => value.toLowerCase()).includes(format)) {
        return res.status(400).json({
          success: false,
          message: `This order does not accept ${format.toUpperCase()} files.`
        });
      }

      verifiedDocument = await getVerifiedDataEntryDocument(
        documentPublicId,
        req.user._id,
        order._id,
        format
      );
    }

    const session = await mongoose.startSession();
    let savedSubmission = null;
    let previousPublicId = null;
    const submittedAt = new Date();

    try {
      await session.withTransaction(async () => {
        savedSubmission = null;
        previousPublicId = null;

        // The first submission must beat the assignment deadline.
        // A revision-requested assignment belongs to the same worker and
        // can be resubmitted without another bid charge.
        const activeOrder = await DataEntryOrder.findOneAndUpdate(
          {
            _id: order._id,
            assignedUserId: req.user._id,
            $or: [
              {
                status: "assigned",
                claimedAt: { $ne: null },
                assignmentExpiresAt: { $gt: submittedAt }
              },
              { status: "revision_requested" }
            ]
          },
          {
            $set: {
              status: "submitted",
              submittedAt,
              assignmentExpiresAt: null
            }
          },
          {
            new: true,
            session,
            runValidators: true
          }
        );

        if (!activeOrder) {
          const error = new Error("ASSIGNMENT_CHANGED");
          error.code = "ASSIGNMENT_CHANGED";
          throw error;
        }

        let submission = await DataEntrySubmission.findOne({
          orderId: activeOrder._id,
          userId: req.user._id
        }).session(session);

        if (submission) {
          if (submission.status !== "revision_requested") {
            const error = new Error("SUBMISSION_NOT_REVISION");
            error.code = "SUBMISSION_NOT_REVISION";
            throw error;
          }

          previousPublicId = submission.documentPublicId || null;

          submission.submissionText = submissionText;
          submission.submissionLink = submissionLink;
          submission.documentPublicId = documentPublicId || null;
          submission.documentOriginalName = documentOriginalName || "";
          submission.documentBytes = verifiedDocument?.bytes || null;
          submission.documentFormat = format;
          submission.status = "submitted";
          submission.submittedAt = submittedAt;
          submission.revisionCount += 1;
          submission.reviewNote = "";
          submission.reviewedBy = null;
          submission.reviewedAt = null;

          await submission.save({ session });
        } else {
          submission = new DataEntrySubmission({
            orderId: activeOrder._id,
            userId: req.user._id,
            orderTitle: activeOrder.title,
            submissionText,
            submissionLink,
            documentPublicId: documentPublicId || null,
            documentOriginalName: documentOriginalName || "",
            documentBytes: verifiedDocument?.bytes || null,
            documentFormat: format,
            status: "submitted",
            submittedAt,
            rewardCents: activeOrder.rewardCents
          });

          await submission.save({ session });
        }

        savedSubmission = submission.toObject();
      });
    } finally {
      await session.endSession();
    }

    return res.status(existing ? 200 : 201).json({
      success: true,
      message: existing
        ? "Your revised Data Entry submission has been sent for review."
        : "Your Data Entry submission has been sent for review.",
      submission: {
        _id: savedSubmission._id,
        orderId: savedSubmission.orderId,
        orderTitle: savedSubmission.orderTitle,
        status: savedSubmission.status,
        submittedAt: savedSubmission.submittedAt,
        revisionCount: savedSubmission.revisionCount,
        documentOriginalName: savedSubmission.documentOriginalName,
        documentFormat: savedSubmission.documentFormat,
        documentBytes: savedSubmission.documentBytes
      }
    });
  } catch (error) {
    if (error.code === "ASSIGNMENT_CHANGED") {
      return res.status(409).json({
        success: false,
        message: "Your assignment changed or expired while submitting. Refresh your orders."
      });
    }

    if (error.code === "SUBMISSION_NOT_REVISION") {
      return res.status(409).json({
        success: false,
        message: "Only a submission with a revision request can be resubmitted."
      });
    }

    if (
      error.message &&
      /Cloudinary|uploaded|XLSX|CSV|UTF-8|worksheet|file size|document reference/i.test(error.message)
    ) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    console.error("Data Entry submission error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not submit your Data Entry work."
    });
  }
});

/*
 * GET /api/data-entry/submissions
 * Returns only the authenticated worker's submission history.
 */
router.get("/submissions", async (req, res) => {
  try {
    const submissions = await DataEntrySubmission.find({
      userId: req.user._id
    })
      .select(
        "_id orderId orderTitle submissionText submissionLink documentOriginalName documentFormat documentBytes status submittedAt revisionCount reviewHistory reviewNote reviewedAt rewardCents"
      )
      .sort({ submittedAt: -1 })
      .lean();

    return res.json({
      success: true,
      submissions
    });
  } catch (error) {
    console.error("Data Entry submission history error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not load your Data Entry submissions."
    });
  }
});


/*
 * GET /api/data-entry/bids
 * Returns the authenticated worker's bid wallet and transaction history.
 */
router.get("/bids", async (req, res) => {
  try {
    const [bidWallet, transactions] = await Promise.all([
      DataEntryBidWallet.findOne({ userId: req.user._id })
        .select("balanceBids totalPurchasedBids totalSpentBids")
        .lean(),

      DataEntryBidTransaction.find({ userId: req.user._id })
        .select("_id type bids reference orderId description createdAt")
        .populate({ path: "orderId", select: "title" })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean()
    ]);

    return res.json({
      success: true,
      wallet: {
        balanceBids: bidWallet?.balanceBids || 0,
        totalPurchasedBids: bidWallet?.totalPurchasedBids || 0,
        totalSpentBids: bidWallet?.totalSpentBids || 0
      },
      transactions
    });
  } catch (error) {
    console.error("Data Entry bid history error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not load your Data Entry bid history."
    });
  }
});

module.exports = router;
