"use strict";

const crypto = require("node:crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const requireAuth = require("../middleware/requireAuth");
const User = require("../models/User");
const AdminAuditLog = require("../models/AdminAuditLog");
const BulkEmailPreview = require("../models/BulkEmailPreview");
const BulkEmailCampaign = require("../models/BulkEmailCampaign");
const BulkEmailBatch = require("../models/BulkEmailBatch");

const router = express.Router();
const unsubscribeRouter = express.Router();
const RESEND_EMAIL_BATCH_URL = "https://api.resend.com/emails/batch";
const MAX_BATCH_CONTACTS = 100;
const MAX_CAMPAIGN_RECIPIENTS = 10000;
const PREVIEW_LIFETIME_MS = 5 * 60 * 1000;
const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.use(requireAuth);
router.use((req, res, next) => {
  if (!["admin", "founder"].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: "Administrator access is required." });
  }
  next();
});

const previewLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
const sendLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false });

function hmacSecret() {
  const secret = process.env.BULK_EMAIL_UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("BULK_EMAIL_UNSUBSCRIBE_SECRET or a 32-character JWT_SECRET is required.");
  return secret;
}

function makeUnsubscribeToken(userId) {
  const id = String(userId);
  const signature = crypto.createHmac("sha256", hmacSecret()).update(id).digest("hex");
  return `${id}.${signature}`;
}

function parseUnsubscribeToken(token) {
  if (typeof token !== "string") return null;
  const [id, signature, extra] = token.split(".");
  if (extra || !mongoose.isValidObjectId(id) || !/^[a-f0-9]{64}$/i.test(signature || "")) return null;
  const expected = Buffer.from(crypto.createHmac("sha256", hmacSecret()).update(id).digest("hex"), "hex");
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected) ? id : null;
}

function requiredPostalAddress() {
  const value = String(process.env.BULK_EMAIL_POSTAL_ADDRESS || "").trim();
  if (!value || value.length > 500) throw new Error("A valid BULK_EMAIL_POSTAL_ADDRESS must be configured before queueing.");
  return value;
}

function apiPublicBase() {
  const configured = String(process.env.BULK_EMAIL_API_PUBLIC_URL || "").trim();
  if (!configured) throw new Error("BULK_EMAIL_API_PUBLIC_URL must be configured as the externally reachable backend URL.");
  const url = new URL(configured);
  if (!["https:"].includes(url.protocol) && process.env.NODE_ENV === "production") {
    throw new Error("BULK_EMAIL_API_PUBLIC_URL must use HTTPS in production.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("BULK_EMAIL_API_PUBLIC_URL must be a valid HTTP(S) origin or base path.");
  }
  return url.toString().replace(/\/$/, "");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

function renderEmail({ firstName, message, postalAddress, unsubscribeUrl = "{{{RESEND_UNSUBSCRIBE_URL}}}" }) {
  const safeName = escapeHtml(firstName || "there");
  const safeMessage = escapeHtml(message).replace(/\r\n|\r|\n/g, "<br>");
  const safeAddress = escapeHtml(postalAddress);
  const safeUnsubscribeUrl = escapeHtml(unsubscribeUrl);
  return {
    html: `<!doctype html><html lang="en"><body style="margin:0;padding:32px 16px;background:#10141c;color:#eef4ff;font-family:Arial,sans-serif"><main style="max-width:620px;margin:0 auto;padding:30px;background:#171e2b;border:1px solid #385277;border-radius:18px"><p style="color:#8bbcff;font-size:12px;font-weight:bold;letter-spacing:2px">PRIMETASK WORKSPACE</p><h1 style="color:#f7fbff;font-size:24px">Hello ${safeName},</h1><div style="color:#d0d9e7;font-size:15px;line-height:1.8">${safeMessage}</div><hr style="height:1px;margin:28px 0;border:0;background:#344359"><p style="color:#9eacc0;font-size:12px;line-height:1.7">You received this email because you opted in to PrimeTask Workspace updates. <a style="color:#91bdff" href="${safeUnsubscribeUrl}">Unsubscribe from future bulk emails</a>.</p><p style="color:#9eacc0;font-size:12px;line-height:1.7">${safeAddress}</p></main></body></html>`,
    text: `Hello ${firstName || "there"},\n\n${message}\n\nYou received this email because you opted in to PrimeTask Workspace updates.\nUnsubscribe from future bulk emails: ${unsubscribeUrl}\n\nPrimeTask Workspace: ${postalAddress}`
  };
}

function audienceUserFilter(audience) {
  if (audience === "active") return { status: "active" };
  if (audience === "inactive") return { status: "inactive" };
  return { status: { $in: ["active", "inactive", "suspended"] } };
}

function consentEligibleFilter() {
  return {
    marketingEmailOptIn: true,
    bulkEmailUnsubscribedAt: null,
    emailVerified: true,
    email: { $type: "string", $regex: validEmail }
  };
}

async function createAudienceSnapshot(audience) {
  const accountFilter = audienceUserFilter(audience);
  const [audienceCount, records] = await Promise.all([
    User.countDocuments({ role: "user", ...accountFilter }),
    User.find({ role: "user", ...accountFilter, ...consentEligibleFilter() })
      .select("_id firstName lastName email marketingEmailOptInAt")
      .sort({ _id: 1 })
      .limit(MAX_CAMPAIGN_RECIPIENTS + 1)
      .lean()
  ]);
  const seen = new Set();
  const recipients = [];
  for (const record of records) {
    const email = String(record.email || "").trim().toLowerCase();
    if (!validEmail.test(email) || seen.has(email)) continue;
    seen.add(email);
    recipients.push({ ...record, email });
  }
  return {
    recipients,
    audienceCount,
    excludedCount: Math.max(0, audienceCount - recipients.length),
    duplicateCount: Math.max(0, records.length - recipients.length)
  };
}

function hashRecipientIds(ids) {
  return crypto.createHash("sha256").update(ids.map(String).sort().join("\n")).digest("hex");
}

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

function checkDeliveryConfiguration() {
  if (process.env.BULK_EMAIL_ENABLED !== "true") {
    throw new Error("Bulk email delivery is disabled. Set BULK_EMAIL_ENABLED=true only after verifying sender and compliance settings.");
  }
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    throw new Error("RESEND_API_KEY and EMAIL_FROM must be configured on the backend.");
  }
  if (!/^[^<>]+<[^<>\s]+@[^<>\s]+>$/.test(process.env.EMAIL_FROM.trim())) {
    throw new Error("EMAIL_FROM must use the format PrimeTask <updates@example.com>.");
  }
  requiredPostalAddress();
  apiPublicBase();
  hmacSecret();
}

async function resendRequest(url, body, idempotencyKey, method = "POST") {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.error?.message || `Resend returned ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function oneClickUnsubscribeUrl(userId) {
  return `${apiPublicBase()}/api/admin/bulk-email/unsubscribe/${makeUnsubscribeToken(userId)}`;
}

async function claimNextBatch() {
  const batch = await BulkEmailBatch.findOneAndUpdate(
    { status: "queued" },
    { $set: { status: "sending", lockToken: randomToken(), lockedAt: new Date() } },
    { sort: { createdAt: 1 }, new: true }
  );
  if (batch) await BulkEmailCampaign.findByIdAndUpdate(batch.campaignId, { $set: { status: "sending" } });
  return batch;
}

async function refreshCampaignStatus(campaignId) {
  const batches = await BulkEmailBatch.find({ campaignId }).lean();
  const sentCount = batches.reduce((sum, item) => sum + Number(item.sentCount || 0), 0);
  const failedCount = batches.reduce((sum, item) => sum + Number(item.failedCount || 0), 0);
  const skippedCount = batches.reduce((sum, item) => sum + Number(item.skippedCount || 0), 0);
  const allDone = batches.every(item => ["sent", "failed"].includes(item.status));
  const anySending = batches.some(item => item.status === "sending");
  const status = allDone ? (failedCount ? "completed_with_errors" : "completed") : (anySending ? "sending" : "queued");
  const firstError = batches.map(item => item.error).find(Boolean) || "";
  await BulkEmailCampaign.findByIdAndUpdate(campaignId, {
    $set: {
      sentCount, failedCount, skippedCount, status,
      ...(firstError ? { lastError: firstError } : {}),
      ...(allDone ? { finishedAt: new Date() } : {})
    }
  });
}

async function processBatch(batch) {
  const campaign = await BulkEmailCampaign.findById(batch.campaignId).lean();
  if (!campaign) throw new Error("Campaign record is missing.");
  const postalAddress = requiredPostalAddress();
  const status = campaign.audience === "active" ? "active" : campaign.audience === "inactive" ? "inactive" : { $in: ["active", "inactive", "suspended"] };
  const recipients = await User.find({
    _id: { $in: batch.recipientIds },
    role: "user",
    status,
    ...consentEligibleFilter()
  }).select("_id firstName email").lean();
  const expectedIds = new Set(batch.recipientIds.map(String));
  const seenEmails = new Set();
  const eligibleRecipients = recipients.filter(user => {
    const email = String(user.email || "").trim().toLowerCase();
    const userId = String(user._id);
    if (!expectedIds.has(userId) || !validEmail.test(email) || seenEmails.has(email)) return false;
    seenEmails.add(email);
    return true;
  });
  const skippedCount = Math.max(0, batch.recipientIds.length - eligibleRecipients.length);

  if (!eligibleRecipients.length) {
    await BulkEmailBatch.updateOne({ _id: batch._id, lockToken: batch.lockToken }, {
      $set: { status: "sent", sentCount: 0, skippedCount, failedCount: 0, lockToken: null }
    });
    return refreshCampaignStatus(batch.campaignId);
  }

  const emails = eligibleRecipients.map(user => {
    const unsubscribeUrl = oneClickUnsubscribeUrl(user._id);
    const content = renderEmail({
      firstName: user.firstName,
      message: campaign.message,
      postalAddress,
      unsubscribeUrl
    });
    return {
      from: process.env.EMAIL_FROM,
      to: [String(user.email).trim().toLowerCase()],
      subject: campaign.subject,
      html: content.html,
      text: content.text,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
      }
    };
  });
  const response = await resendRequest(
    RESEND_EMAIL_BATCH_URL,
    emails,
    `${campaign._id}:${batch.batchNumber}:send`
  );
  const sentEmails = Array.isArray(response?.data) ? response.data : [];
  if (sentEmails.length !== emails.length || sentEmails.some(email => !email?.id)) {
    throw new Error("Resend returned an incomplete batch response; delivery outcome is uncertain and will not be retried automatically.");
  }
  return markBatchSent(batch, sentEmails.length, skippedCount);
}

async function markBatchSent(batch, sentCount, skippedCount) {
  await BulkEmailBatch.updateOne({ _id: batch._id, lockToken: batch.lockToken }, {
    $set: { status: "sent", sentCount, skippedCount, failedCount: 0, lockToken: null, error: "" }
  });
  return refreshCampaignStatus(batch.campaignId);
}

async function failBatch(batch, error) {
  const safeError = String(error?.message || "Delivery failed.").slice(0, 500);
  await BulkEmailBatch.updateOne({ _id: batch._id, lockToken: batch.lockToken }, {
    $set: {
      status: "failed", failedCount: batch.expectedRecipientCount || batch.recipientIds.length,
      lockToken: null, error: safeError
    }
  });
  await refreshCampaignStatus(batch.campaignId);
}

async function markAmbiguousSendsFailed() {
  const staleBefore = new Date(Date.now() - 15 * 60 * 1000);
  const stale = await BulkEmailBatch.find({ status: "sending", lockedAt: { $lt: staleBefore } }).limit(20).lean();
  for (const batch of stale) {
    await BulkEmailBatch.updateOne({ _id: batch._id, status: "sending", lockToken: batch.lockToken }, {
      $set: {
        status: "failed", failedCount: batch.expectedRecipientCount || batch.recipientIds.length,
        lockToken: null, error: "Worker stopped during delivery. Outcome is uncertain; batch was not retried automatically."
      }
    });
    await refreshCampaignStatus(batch.campaignId);
  }
}

let queueTimer = null;
let queueBusy = false;
async function pollQueue() {
  if (queueBusy || mongoose.connection.readyState !== 1) return;
  queueBusy = true;
  try {
    await markAmbiguousSendsFailed();
    const batch = await claimNextBatch();
    if (!batch) return;
    try {
      await processBatch(batch);
    } catch (error) {
      console.error("Bulk email batch failed:", error.message);
      if (batch.resendBroadcastId) {
        await failBatch(batch, new Error("Broadcast send outcome is uncertain; it will not be retried automatically."));
      } else {
        await failBatch(batch, error);
      }
    }
  } finally {
    queueBusy = false;
  }
}

function startBulkEmailQueue() {
  if (queueTimer) return;
  queueTimer = setInterval(() => pollQueue().catch(error => console.error("Bulk email worker failed:", error.message)), 2000);
  queueTimer.unref?.();
  pollQueue();
}

async function stopBulkEmailQueue() {
  if (!queueTimer) return;
  clearInterval(queueTimer);
  queueTimer = null;
  while (queueBusy) await new Promise(resolve => setTimeout(resolve, 50));
}

router.get("/preview", previewLimiter, async (req, res, next) => {
  try {
    const audience = String(req.query.audience || "");
    if (!["active", "inactive", "all"].includes(audience)) {
      return res.status(400).json({ success: false, message: "audience must be active, inactive, or all." });
    }
    const { recipients, audienceCount, excludedCount, duplicateCount } = await createAudienceSnapshot(audience);
    if (recipients.length > MAX_CAMPAIGN_RECIPIENTS) {
      return res.status(413).json({ success: false, message: `This preview exceeds the ${MAX_CAMPAIGN_RECIPIENTS} recipient campaign limit.` });
    }
    const token = randomToken();
    const ids = recipients.map(user => user._id);
    const expiresAt = new Date(Date.now() + PREVIEW_LIFETIME_MS);
    const preview = await BulkEmailPreview.create({
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      adminId: req.user._id, audience, recipientIds: ids,
      recipientHash: hashRecipientIds(ids), eligibleCount: recipients.length,
      excludedCount, duplicateCount, expiresAt
    });
    return res.json({
      success: true,
      preview: {
        previewId: token, audience, eligibleCount: recipients.length,
        excludedCount, duplicateCount, audienceCount, expiresAt: preview.expiresAt
      }
    });
  } catch (error) { return next(error); }
});

router.post("/send", sendLimiter, async (req, res, next) => {
  try {
    const { audience, previewId, subject, message, confirmation } = req.body || {};
    if (!["active", "inactive", "all"].includes(audience)) return res.status(400).json({ success: false, message: "Choose a valid audience." });
    if (typeof subject !== "string" || !subject.trim() || subject.trim().length > 160) return res.status(400).json({ success: false, message: "Subject must be 1–160 characters." });
    if (typeof message !== "string" || !message.trim() || message.trim().length > 12000) return res.status(400).json({ success: false, message: "Message must be 1–12000 characters." });
    if (confirmation !== "SEND") return res.status(400).json({ success: false, message: "Type SEND to confirm this campaign." });
    if (typeof previewId !== "string" || !/^[a-f0-9]{64}$/i.test(previewId)) return res.status(400).json({ success: false, message: "Create a fresh audience preview before queueing." });

    try { checkDeliveryConfiguration(); }
    catch (error) { return res.status(503).json({ success: false, message: error.message }); }

    const tokenHash = crypto.createHash("sha256").update(previewId).digest("hex");
    const preview = await BulkEmailPreview.findOneAndUpdate({
      tokenHash,
      adminId: req.user._id,
      audience,
      usedAt: null,
      expiresAt: { $gt: new Date() }
    }, { $set: { usedAt: new Date() } }, { new: true });
    if (!preview) return res.status(409).json({ success: false, message: "This preview is expired, already used, or does not match the selected audience. Preview again." });
    if (preview.recipientIds.length > MAX_CAMPAIGN_RECIPIENTS) return res.status(413).json({ success: false, message: "This campaign exceeds the recipient limit." });

    const { recipients } = await createAudienceSnapshot(audience);
    const freshIds = recipients.map(user => user._id);
    if (hashRecipientIds(freshIds) !== preview.recipientHash) {
      return res.status(409).json({ success: false, message: "The opted-in audience changed after preview. Preview again before queueing." });
    }
    if (recipients.length !== preview.recipientIds.length) return res.status(409).json({ success: false, message: "The recipient count changed after preview. Preview again before queueing." });

    const campaign = await BulkEmailCampaign.create({
      subject: subject.trim(), message: message.trim(), audience,
      status: "queued", createdBy: req.user._id, recipientCount: recipients.length,
      totalBatches: Math.ceil(recipients.length / MAX_BATCH_CONTACTS)
    });
    const batches = [];
    for (let index = 0; index < preview.recipientIds.length; index += MAX_BATCH_CONTACTS) {
      batches.push({
        campaignId: campaign._id,
        batchNumber: batches.length,
        recipientIds: preview.recipientIds.slice(index, index + MAX_BATCH_CONTACTS)
      });
    }
    if (batches.length) {
      try {
        await BulkEmailBatch.insertMany(batches);
      } catch (error) {
        await BulkEmailCampaign.findByIdAndUpdate(campaign._id, {
          $set: { status: "failed", lastError: "Campaign batches could not be safely queued.", finishedAt: new Date() }
        });
        throw error;
      }
    }
    if (!batches.length) {
      campaign.status = "completed";
      campaign.finishedAt = new Date();
      await campaign.save();
    }
    try {
      await AdminAuditLog.create({
        adminId: req.user._id,
        targetUserId: req.user._id,
        action: "bulk_email_campaign_queued",
        reason: `Queued bulk email campaign ${campaign._id} for ${audience} opted-in members.`,
        after: { campaignId: String(campaign._id), subject: campaign.subject, audience, recipientCount: campaign.recipientCount },
        ipAddress: String(req.ip || "").slice(0, 100)
      });
    } catch (error) { console.error("Bulk email campaign audit log failed:", error.message); }
    return res.status(202).json({ success: true, campaign: serializeCampaign(campaign) });
  } catch (error) { return next(error); }
});

function serializeCampaign(campaign, batches = []) {
  const initial = batches.length ? { sentCount: 0, failedCount: 0, skippedCount: 0 } : {
    sentCount: Number(campaign.sentCount || 0),
    failedCount: Number(campaign.failedCount || 0),
    skippedCount: Number(campaign.skippedCount || 0)
  };
  const totals = batches.reduce((result, batch) => ({
    sentCount: result.sentCount + Number(batch.sentCount || 0),
    failedCount: result.failedCount + Number(batch.failedCount || 0),
    skippedCount: result.skippedCount + Number(batch.skippedCount || 0)
  }), initial);
  return {
    campaignId: String(campaign._id), subject: campaign.subject, audience: campaign.audience,
    status: campaign.status, recipientCount: campaign.recipientCount,
    sentCount: totals.sentCount, failedCount: totals.failedCount, skippedCount: totals.skippedCount,
    totalBatches: campaign.totalBatches, error: campaign.lastError || batches.map(item => item.error).find(Boolean) || "",
    createdAt: campaign.createdAt, finishedAt: campaign.finishedAt || null
  };
}

router.get("/campaigns", async (req, res, next) => {
  try {
    const campaigns = await BulkEmailCampaign.find({}).sort({ createdAt: -1 }).limit(50).lean();
    const ids = campaigns.map(item => item._id);
    const batches = ids.length ? await BulkEmailBatch.find({ campaignId: { $in: ids } }).lean() : [];
    const byCampaign = new Map();
    for (const batch of batches) {
      const key = String(batch.campaignId);
      if (!byCampaign.has(key)) byCampaign.set(key, []);
      byCampaign.get(key).push(batch);
    }
    return res.json({ success: true, campaigns: campaigns.map(item => serializeCampaign(item, byCampaign.get(String(item._id)) || [])) });
  } catch (error) { return next(error); }
});

router.get("/campaigns/:campaignId", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.campaignId)) return res.status(400).json({ success: false, message: "Invalid campaign ID." });
    const campaign = await BulkEmailCampaign.findById(req.params.campaignId).lean();
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found." });
    const batches = await BulkEmailBatch.find({ campaignId: campaign._id }).sort({ batchNumber: 1 }).lean();
    return res.json({ success: true, campaign: serializeCampaign(campaign, batches) });
  } catch (error) { return next(error); }
});

const unsubscribePage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences | PrimeTask Workspace</title><body style="margin:0;padding:40px 16px;background:#10141c;color:#eef4ff;font:16px/1.6 Arial,sans-serif"><main style="max-width:520px;margin:8vh auto;padding:28px;background:#171e2b;border:1px solid #385277;border-radius:16px"><h1>Email preferences</h1><p>Confirm to stop receiving future PrimeTask Workspace bulk emails. This does not affect account or security messages.</p><form method="post"><input type="hidden" name="confirm" value="unsubscribe"><button style="padding:12px 16px;border:0;border-radius:8px;background:#93c5fd;color:#06101e;font-weight:bold" type="submit">Unsubscribe me</button></form></main></body></html>`;

unsubscribeRouter.use(express.urlencoded({ extended: false, type: "application/x-www-form-urlencoded" }));
unsubscribeRouter.get("/:token", (req, res) => {
  if (!parseUnsubscribeToken(req.params.token)) return res.status(400).type("text").send("This unsubscribe link is invalid.");
  return res.type("html").send(unsubscribePage);
});

unsubscribeRouter.post("/:token", async (req, res, next) => {
  try {
    const oneClick = req.body?.["List-Unsubscribe"] === "One-Click";
    const encodedForm = String(req.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded");
    if (!oneClick && !(encodedForm && req.body?.confirm === "unsubscribe")) return res.status(400).type("text").send("Confirm the unsubscribe request to continue.");
    const userId = parseUnsubscribeToken(req.params.token);
    if (!userId) return res.status(400).type("text").send("This unsubscribe link is invalid.");
    await User.findByIdAndUpdate(userId, { $set: { bulkEmailUnsubscribedAt: new Date(), marketingEmailOptIn: false, marketingEmailOptInAt: null } });
    try {
      await AdminAuditLog.create({
        adminId: userId, targetUserId: userId, action: "bulk_email_unsubscribed",
        reason: "Recipient opted out of future PrimeTask bulk email.",
        after: { marketingEmailOptIn: false, unsubscribed: true }, ipAddress: String(req.ip || "").slice(0, 100)
      });
    } catch (error) { console.error("Bulk email unsubscribe audit log failed:", error.message); }
    return res.type("html").send("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Unsubscribed</title><body style=\"margin:0;padding:48px;background:#10141c;color:#eef4ff;font:16px Arial,sans-serif\"><h1>You’re unsubscribed</h1><p>You will not receive future PrimeTask Workspace bulk emails.</p></body></html>");
  } catch (error) { return next(error); }
});

module.exports = {
  router, unsubscribe: unsubscribeRouter, startBulkEmailQueue, stopBulkEmailQueue,
  makeUnsubscribeToken, parseUnsubscribeToken, renderEmail,
  _test: { createAudienceSnapshot, hashRecipientIds, checkDeliveryConfiguration, processBatch },
  constants: { MAX_BATCH_CONTACTS, MAX_CAMPAIGN_RECIPIENTS }
};