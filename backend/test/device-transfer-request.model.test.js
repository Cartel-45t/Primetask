"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const DeviceTransferRequest =
  require("../src/models/DeviceTransferRequest");

function validRequest(overrides = {}) {
  return new DeviceTransferRequest({
    userId: new mongoose.Types.ObjectId(),
    oldRegistrationId: new mongoose.Types.ObjectId(),
    oldDeviceId: new mongoose.Types.ObjectId(),
    proposedDeviceId: new mongoose.Types.ObjectId(),
    ...overrides
  });
}

test("requires account, old registration, old device and proposed device", async () => {
  const request = new DeviceTransferRequest({});
  const error = await request.validate().catch(err => err);

  assert.ok(error);
  for (const field of [
    "userId",
    "oldRegistrationId",
    "oldDeviceId",
    "proposedDeviceId"
  ]) {
    assert.ok(error.errors[field], `Expected ${field} to be required.`);
  }
});

test("uses pending status and initializes request counters", () => {
  const request = validRequest();

  assert.equal(request.status, "pending");
  assert.equal(request.requestCount, 1);
  assert.equal(request.failedAttempts, 0);
  assert.ok(request.firstRequestedAt instanceof Date);
  assert.ok(request.lastRequestedAt instanceof Date);
  assert.equal(request.lastAttemptAt, null);
});

test("accepts valid transfer decision statuses", async () => {
  for (const status of ["pending", "approved", "rejected", "cancelled"]) {
    const request = validRequest({ status });
    await assert.doesNotReject(request.validate());
  }
});

test("rejects unsupported transfer statuses", async () => {
  const request = validRequest({ status: "verified_by_email" });
  const error = await request.validate().catch(err => err);

  assert.ok(error.errors.status);
});

test("rejects negative request counters", async () => {
  const request = validRequest({
    requestCount: 0,
    failedAttempts: -1
  });

  const error = await request.validate().catch(err => err);

  assert.ok(error.errors.requestCount);
  assert.ok(error.errors.failedAttempts);
});

test("enforces request metadata length limits", async () => {
  const request = validRequest({
    requestIp: "1".repeat(101),
    requestUserAgent: "A".repeat(1001),
    reviewReason: "R".repeat(1001)
  });

  const error = await request.validate().catch(err => err);

  assert.ok(error.errors.requestIp);
  assert.ok(error.errors.requestUserAgent);
  assert.ok(error.errors.reviewReason);
});

test("supports administrator review metadata", async () => {
  const adminId = new mongoose.Types.ObjectId();
  const reviewedAt = new Date();

  const request = validRequest({
    status: "approved",
    reviewedByAdminId: adminId,
    reviewedAt,
    approvedAt: reviewedAt,
    reviewReason: "Identity and device history reviewed."
  });

  await assert.doesNotReject(request.validate());

  assert.equal(request.reviewedByAdminId.toString(), adminId.toString());
  assert.equal(request.reviewedAt.getTime(), reviewedAt.getTime());
});

test("defines one pending transfer request per account", () => {
  const indexes = DeviceTransferRequest.schema.indexes();

  const pendingIndex = indexes.find(([keys, options]) =>
    keys.userId === 1 &&
    options.unique === true &&
    options.name === "one_pending_device_transfer_per_account"
  );

  assert.ok(pendingIndex);
  assert.deepEqual(
    pendingIndex[1].partialFilterExpression,
    { status: "pending" }
  );
});

test("preserves account and device transfer history indexes", () => {
  const indexes = DeviceTransferRequest.schema.indexes();

  const hasIndex = expected => indexes.some(([keys]) =>
    Object.entries(expected).every(
      ([field, direction]) => keys[field] === direction
    )
  );

  assert.ok(hasIndex({ userId: 1, createdAt: -1 }));
  assert.ok(hasIndex({ status: 1, createdAt: -1 }));
  assert.ok(hasIndex({ proposedDeviceId: 1, createdAt: -1 }));
  assert.ok(hasIndex({ oldDeviceId: 1, createdAt: -1 }));
});

test("does not define email verification tokens or expiry fields", () => {
  const fields = DeviceTransferRequest.schema.paths;

  assert.equal(fields.tokenHash, undefined);
  assert.equal(fields.expiresAt, undefined);
  assert.equal(fields.consumedAt, undefined);
});
