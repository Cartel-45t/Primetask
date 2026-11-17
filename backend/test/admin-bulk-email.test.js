"use strict";

const { test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "bulk-email-test-secret-that-is-long-enough";

const User = require("../src/models/User");
const AdminAuditLog = require("../src/models/AdminAuditLog");
const BulkEmailPreview = require("../src/models/BulkEmailPreview");
const BulkEmailCampaign = require("../src/models/BulkEmailCampaign");
const BulkEmailBatch = require("../src/models/BulkEmailBatch");
const deviceAccessService = require("../src/services/deviceAccessService");
const bulkEmailRoutes = require("../src/routes/adminBulkEmail");
const profileRoutes = require("../src/routes/profile");

const originals = {
  userFindById: User.findById,
  userFind: User.find,
  userCountDocuments: User.countDocuments,
  userFindByIdAndUpdate: User.findByIdAndUpdate,
  userFindOne: User.findOne,
  auditCreate: AdminAuditLog.create,
  previewCreate: BulkEmailPreview.create,
  previewFindOneAndUpdate: BulkEmailPreview.findOneAndUpdate,
  campaignCreate: BulkEmailCampaign.create,
  campaignFind: BulkEmailCampaign.find,
  campaignFindById: BulkEmailCampaign.findById,
  batchInsertMany: BulkEmailBatch.insertMany,
  batchFind: BulkEmailBatch.find,
  readyState: require("mongoose").connection.readyState,
  authorizeRequestDevice: deviceAccessService.authorizeRequestDevice,
  env: Object.fromEntries([
    "BULK_EMAIL_ENABLED", "RESEND_API_KEY", "EMAIL_FROM", "BULK_EMAIL_POSTAL_ADDRESS",
    "BULK_EMAIL_API_PUBLIC_URL", "BULK_EMAIL_UNSUBSCRIBE_SECRET"
  ].map(key => [key, process.env[key]]))
};

const adminId = "507f1f77bcf86cd799439011";
let server;
let baseUrl;
let users;
let previewDocument;
let campaigns;
let batches;
let auditEntries;
let authenticatedRole = "admin";

function queryResult(value) {
  return {
    select() { return this; },
    sort() { return this; },
    limit() { return this; },
    lean: async () => value
  };
}

function makePreviewQuery() {
  const chain = {
    select() { return chain; },
    sort() { return chain; },
    limit() { return chain; },
    lean: async () => {
      const filter = chain.filter || {};
      return users.filter(user => {
        if (filter.role && user.role !== filter.role) return false;
        if (filter.status === "active" && user.status !== "active") return false;
        if (filter.status === "inactive" && user.status !== "inactive") return false;
        if (filter.status?.$in && !filter.status.$in.includes(user.status)) return false;
        if (filter.marketingEmailOptIn && !user.marketingEmailOptIn) return false;
        if (filter.emailVerified && !user.emailVerified) return false;
        if (filter.bulkEmailUnsubscribedAt === null && user.bulkEmailUnsubscribedAt) return false;
        return true;
      });
    }
  };
  return Object.assign(chain, { filter: null });
}

function cookieFor(role) {
  authenticatedRole = role;
  const token = jwt.sign({ sub: adminId, role }, process.env.JWT_SECRET, {
    expiresIn: "5m", issuer: "primetask-workspace", audience: "primetask-workspace-users"
  });
  return `ptw_session=${token}`;
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.role) headers.Cookie = cookieFor(options.role);
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(baseUrl + path, {
    ...options, headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const type = response.headers.get("content-type") || "";
  return { response, body: type.includes("json") ? await response.json() : await response.text() };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false, type: "application/x-www-form-urlencoded" }));
  app.use(cookieParser());
  app.use("/api/admin/bulk-email/unsubscribe", bulkEmailRoutes.unsubscribe);
  app.use("/api/admin/bulk-email", bulkEmailRoutes.router);
  app.use("/api/profile", profileRoutes);
  app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).json({ success: false, message: "Test server error." });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  users = [
    { _id: "507f1f77bcf86cd799439021", email: "  Member@example.com ", firstName: "Member", lastName: "One", status: "active", role: "user", marketingEmailOptIn: true, emailVerified: true, bulkEmailUnsubscribedAt: null },
    { _id: "507f1f77bcf86cd799439022", email: "member@example.com", firstName: "Member", lastName: "Duplicate", status: "active", role: "user", marketingEmailOptIn: true, emailVerified: true, bulkEmailUnsubscribedAt: null },
    { _id: "507f1f77bcf86cd799439023", email: "inactive@example.com", firstName: "Inactive", lastName: "Member", status: "inactive", role: "user", marketingEmailOptIn: true, emailVerified: true, bulkEmailUnsubscribedAt: null }
  ];
  previewDocument = null;
  campaigns = [];
  batches = [];
  auditEntries = [];
  process.env.BULK_EMAIL_ENABLED = "false";

  User.findById = () => ({ select: async () => ({ _id: adminId, role: authenticatedRole, status: "active", sessionVersion: 0 }) });
  User.countDocuments = async filter => users.filter(user => {
    if (filter.role && user.role !== filter.role) return false;
    if (filter.status === "active" && user.status !== "active") return false;
    if (filter.status === "inactive" && user.status !== "inactive") return false;
    if (filter.status?.$in && !filter.status.$in.includes(user.status)) return false;
    return true;
  }).length;
  User.find = filter => Object.assign(makePreviewQuery(), { filter });
  User.findByIdAndUpdate = (id, update) => {
    const result = {
      _id: id,
      marketingEmailOptIn: update.$set.marketingEmailOptIn,
      marketingEmailOptInAt: update.$set.marketingEmailOptInAt,
      bulkEmailUnsubscribedAt: update.$set.bulkEmailUnsubscribedAt
    };
    return { select() { return this; }, lean: async () => result };
  };
  User.findOne = () => queryResult(null);
  AdminAuditLog.create = async entry => { auditEntries.push(entry); return entry; };
  BulkEmailPreview.create = async document => {
    previewDocument = { ...document, _id: "507f1f77bcf86cd799439031" };
    return previewDocument;
  };
  BulkEmailPreview.findOneAndUpdate = async filter => {
    if (!previewDocument || previewDocument.tokenHash !== filter.tokenHash || previewDocument.audience !== filter.audience) return null;
    return previewDocument;
  };
  BulkEmailCampaign.create = async document => {
    const campaign = {
      ...document, _id: "507f1f77bcf86cd799439041", createdAt: new Date(), finishedAt: null,
      async save() { return this; }
    };
    campaigns.push(campaign);
    return campaign;
  };
  BulkEmailCampaign.find = () => queryResult(campaigns);
  BulkEmailCampaign.findById = () => queryResult(campaigns[0] || null);
  BulkEmailBatch.insertMany = async docs => { batches.push(...docs); return docs; };
  BulkEmailBatch.find = () => queryResult(batches);
  require("mongoose").connection.readyState = 0;
  deviceAccessService.authorizeRequestDevice = async () => ({ allowed: true, deviceId: "507f1f77bcf86cd799439012" });
});

afterEach(() => {
  User.findById = originals.userFindById;
  User.find = originals.userFind;
  User.countDocuments = originals.userCountDocuments;
  User.findByIdAndUpdate = originals.userFindByIdAndUpdate;
  User.findOne = originals.userFindOne;
  AdminAuditLog.create = originals.auditCreate;
  BulkEmailPreview.create = originals.previewCreate;
  BulkEmailPreview.findOneAndUpdate = originals.previewFindOneAndUpdate;
  BulkEmailCampaign.create = originals.campaignCreate;
  BulkEmailCampaign.find = originals.campaignFind;
  BulkEmailCampaign.findById = originals.campaignFindById;
  BulkEmailBatch.insertMany = originals.batchInsertMany;
  BulkEmailBatch.find = originals.batchFind;
  require("mongoose").connection.readyState = originals.readyState;
  deviceAccessService.authorizeRequestDevice = originals.authorizeRequestDevice;
  for (const [key, value] of Object.entries(originals.env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

test("preview validates audience and role checks are based on the authenticated user record", async () => {
  assert.equal((await request("/api/admin/bulk-email/preview?audience=active")).response.status, 401);
  authenticatedRole = "user";
  assert.equal((await request("/api/admin/bulk-email/preview?audience=active", { role: "user" })).response.status, 403);
  authenticatedRole = "admin";
  assert.equal((await request("/api/admin/bulk-email/preview?audience=bad", { role: "admin" })).response.status, 400);
});

test("preview deduplicates email addresses and returns fresh token and counts", async () => {
  const { response, body } = await request("/api/admin/bulk-email/preview?audience=active", { role: "admin" });
  assert.equal(response.status, 200);
  assert.equal(body.preview.eligibleCount, 1);
  assert.equal(body.preview.duplicateCount, 1);
  assert.match(body.preview.previewId, /^[a-f0-9]{64}$/);
  assert.equal(previewDocument.recipientIds.length, 1);
});

test("queueing is blocked until delivery configuration is deliberately enabled", async () => {
  const { body: previewBody } = await request("/api/admin/bulk-email/preview?audience=active", { role: "admin" });
  const { response, body } = await request("/api/admin/bulk-email/send", {
    method: "POST", role: "admin",
    body: { audience: "active", previewId: previewBody.preview.previewId, subject: "Service update", message: "Hello members", confirmation: "SEND" }
  });
  assert.equal(response.status, 503);
  assert.match(body.message, /BULK_EMAIL_ENABLED/);
  assert.equal(campaigns.length, 0);
});

test("send validates exact confirmation and requires a matching unused preview", async () => {
  const invalid = await request("/api/admin/bulk-email/send", {
    method: "POST", role: "admin",
    body: { audience: "active", previewId: "0".repeat(64), subject: "Update", message: "Hello", confirmation: "send" }
  });
  assert.equal(invalid.response.status, 400);
});

test("campaign activity returns serialized campaigns with counters", async () => {
  campaigns = [{ _id: "507f1f77bcf86cd799439041", subject: "Update", audience: "active", status: "queued", recipientCount: 3, sentCount: 0, failedCount: 0, skippedCount: 0, totalBatches: 1, createdAt: new Date(), finishedAt: null }];
  const { response, body } = await request("/api/admin/bulk-email/campaigns", { role: "admin" });
  assert.equal(response.status, 200);
  assert.equal(body.campaigns[0].campaignId, campaigns[0]._id);
  assert.equal(body.campaigns[0].recipientCount, 3);
});

test("member preference endpoint opts in and out and records audit", async () => {
  assert.equal((await request("/api/profile/marketing-email", { method: "PATCH", role: "user", body: { marketingEmailOptIn: true } })).response.status, 200);
  assert.equal((await request("/api/profile/marketing-email", { method: "PATCH", role: "user", body: { marketingEmailOptIn: "true" } })).response.status, 400);
  assert.equal(auditEntries.length, 1);
});

test("unsubscribe tokens are signed and HTML email escapes submitted content", () => {
  process.env.BULK_EMAIL_UNSUBSCRIBE_SECRET = "unsubscribe-test-secret-at-least-32-characters";
  const token = bulkEmailRoutes.makeUnsubscribeToken("507f1f77bcf86cd799439011");
  assert.equal(bulkEmailRoutes.parseUnsubscribeToken(token), "507f1f77bcf86cd799439011");
  assert.equal(bulkEmailRoutes.parseUnsubscribeToken(token + "x"), null);
  const content = bulkEmailRoutes.renderEmail({ firstName: "<One>", message: "<script>alert(1)</script>", postalAddress: "PO Box 1" });
  assert.doesNotMatch(content.html, /<script>/);
  assert.match(content.html, /RESEND_UNSUBSCRIBE_URL/);
  assert.match(content.text, /PO Box 1/);
});

test("unsubscribe GET requires confirmation and one-click POST has no redirect dependency", async () => {
  process.env.BULK_EMAIL_UNSUBSCRIBE_SECRET = "unsubscribe-test-secret-at-least-32-characters";
  const token = bulkEmailRoutes.makeUnsubscribeToken("507f1f77bcf86cd799439011");
  const get = await request(`/api/admin/bulk-email/unsubscribe/${token}`);
  assert.equal(get.response.status, 200);
  assert.match(get.body, /Unsubscribe me/);
});