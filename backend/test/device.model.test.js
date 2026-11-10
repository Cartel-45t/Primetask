"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Device = require("../src/models/Device");

test("device identity requires a valid credential hash", async () => {
  const missingHash = new Device({});

  await assert.rejects(
    missingHash.validate(),
    error => error.errors.deviceKeyHash?.kind === "required"
  );

  const invalidHash = new Device({
    deviceKeyHash: "not-a-valid-hash"
  });

  await assert.rejects(
    invalidHash.validate(),
    error => Boolean(error.errors.deviceKeyHash)
  );
});

test("device identity defaults to active and records registration time", async () => {
  const device = new Device({
    deviceKeyHash: "a".repeat(64)
  });

  await device.validate();

  assert.equal(device.status, "active");
  assert.ok(device.registeredAt instanceof Date);
  assert.ok(device.lastSeenAt instanceof Date);
  assert.equal(device.bannedAt, null);
});

test("device identity accepts only active or banned status", async () => {
  for (const status of ["active", "banned"]) {
    const device = new Device({
      deviceKeyHash: "a".repeat(64),
      status
    });

    await device.validate();
    assert.equal(device.status, status);
  }

  const invalid = new Device({
    deviceKeyHash: "a".repeat(64),
    status: "revoked"
  });

  await assert.rejects(
    invalid.validate(),
    error => Boolean(error.errors.status)
  );
});

test("device identity metadata has bounded lengths", async () => {
  const device = new Device({
    deviceKeyHash: "a".repeat(64),
    deviceLabel: "x".repeat(101)
  });

  await assert.rejects(
    device.validate(),
    error => Boolean(error.errors.deviceLabel)
  );
});

test("credential hash is excluded from normal query selection", () => {
  const path = Device.schema.path("deviceKeyHash");

  assert.equal(path.options.select, false);
  assert.equal(path.options.unique, true);
});

test("device identity has a status and last-seen index", () => {
  const indexes = Device.schema.indexes();

  assert.ok(
    indexes.some(([fields]) =>
      fields.status === 1 && fields.lastSeenAt === -1
    )
  );
});

test("device identity does not depend on a user account", () => {
  assert.equal(Device.schema.path("userId"), undefined);
});
