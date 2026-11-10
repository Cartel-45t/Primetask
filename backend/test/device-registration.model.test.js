"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const DeviceRegistration = require("../src/models/DeviceRegistration");

function validRegistration() {
  return {
    userId: new mongoose.Types.ObjectId(),
    deviceId: new mongoose.Types.ObjectId()
  };
}

test("registration requires both an account and a device identity", async () => {
  const missingUser = new DeviceRegistration({
    deviceId: new mongoose.Types.ObjectId()
  });

  await assert.rejects(
    missingUser.validate(),
    error => error.errors.userId?.kind === "required"
  );

  const missingDevice = new DeviceRegistration({
    userId: new mongoose.Types.ObjectId()
  });

  await assert.rejects(
    missingDevice.validate(),
    error => error.errors.deviceId?.kind === "required"
  );
});

test("registration defaults to active", async () => {
  const registration = new DeviceRegistration(validRegistration());

  await registration.validate();

  assert.equal(registration.status, "active");
  assert.ok(registration.registeredAt instanceof Date);
  assert.ok(registration.lastSeenAt instanceof Date);
  assert.equal(registration.revokedAt, null);
});

test("registration accepts only active or revoked status", async () => {
  for (const status of ["active", "revoked"]) {
    const registration = new DeviceRegistration({
      ...validRegistration(),
      status
    });

    await registration.validate();
    assert.equal(registration.status, status);
  }

  const invalid = new DeviceRegistration({
    ...validRegistration(),
    status: "banned"
  });

  await assert.rejects(
    invalid.validate(),
    error => Boolean(error.errors.status)
  );
});

test("database indexes enforce one active device per account", () => {
  const indexes = DeviceRegistration.schema.indexes();

  const activeIndex = indexes.find(([fields, options]) =>
    fields.userId === 1 &&
    options.unique === true &&
    options.partialFilterExpression?.status === "active"
  );

  assert.ok(activeIndex);
});

test("registration history allows repeated account-device pairs", () => {
  const indexes = DeviceRegistration.schema.indexes();

  const historyIndex = indexes.find(([fields, options]) =>
    fields.userId === 1 &&
    fields.deviceId === 1 &&
    options.name === "account_device_registration_history"
  );

  assert.ok(historyIndex);
  assert.notEqual(historyIndex[1].unique, true);
});

test("only one active registration is allowed per account", () => {
  const indexes = DeviceRegistration.schema.indexes();

  const activeIndex = indexes.find(([fields, options]) =>
    fields.userId === 1 &&
    options.unique === true &&
    options.partialFilterExpression?.status === "active"
  );

  assert.ok(activeIndex);
});

test("registration metadata has bounded lengths", async () => {
  const registration = new DeviceRegistration({
    ...validRegistration(),
    revokedReason: "x".repeat(501)
  });

  await assert.rejects(
    registration.validate(),
    error => Boolean(error.errors.revokedReason)
  );
});
