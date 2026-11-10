"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const SecurityEvent = require("../src/models/SecurityEvent");

function validEvent() {
  return {
    eventType: "login_success",
    outcome: "success",
    sequence: 1,
    previousHash: "0".repeat(64),
    eventHash: "a".repeat(64)
  };
}

test("security event requires an event type and outcome", async () => {
  const missingType = new SecurityEvent({ outcome: "success" });

  await assert.rejects(
    missingType.validate(),
    error => Boolean(error.errors.eventType)
  );

  const missingOutcome = new SecurityEvent({
    eventType: "login_success"
  });

  await assert.rejects(
    missingOutcome.validate(),
    error => Boolean(error.errors.outcome)
  );
});

test("security event accepts supported event types", async () => {
  const eventTypes = [
    "login_success",
    "login_failed",
    "logout",
    "session_revoked",
    "device_registered",
    "device_transfer_requested",
    "device_transfer_failed",
    "device_transfer_completed",
    "device_banned",
    "device_unbanned",
    "device_access_denied",
    "password_reset_requested",
    "password_reset_completed",
    "rate_limit_triggered",
    "suspicious_request",
    "admin_security_action"
  ];

  for (const eventType of eventTypes) {
    const event = new SecurityEvent({
      ...validEvent(),
      eventType
    });

    await event.validate();
    assert.equal(event.eventType, eventType);
  }
});

test("security event rejects unknown event types and outcomes", async () => {
  const invalidType = new SecurityEvent({
    ...validEvent(),
    eventType: "password_stolen"
  });

  await assert.rejects(invalidType.validate());

  const invalidOutcome = new SecurityEvent({
    eventType: "login_success",
    outcome: "maybe"
  });

  await assert.rejects(invalidOutcome.validate());
});

test("security event defaults to informational severity", async () => {
  const event = new SecurityEvent(validEvent());

  await event.validate();

  assert.equal(event.severity, "info");
});

test("security event accepts valid account and device references", async () => {
  const userId = new mongoose.Types.ObjectId();
  const deviceId = new mongoose.Types.ObjectId();

  const event = new SecurityEvent({
    ...validEvent(),
    userId,
    actorUserId: userId,
    targetUserId: userId,
    deviceId
  });

  await event.validate();

  assert.equal(event.userId.toString(), userId.toString());
  assert.equal(event.deviceId.toString(), deviceId.toString());
});

test("security event bounds request metadata", async () => {
  const event = new SecurityEvent({
    ...validEvent(),
    ipAddress: "x".repeat(101),
    userAgent: "x".repeat(1001),
    path: "x".repeat(501),
    message: "x".repeat(1001)
  });

  await assert.rejects(event.validate());
});

test("security event validates HTTP status and duration", async () => {
  for (const statusCode of [99, 600]) {
    const event = new SecurityEvent({
      ...validEvent(),
      statusCode
    });

    await assert.rejects(event.validate());
  }

  const negativeDuration = new SecurityEvent({
    ...validEvent(),
    durationMs: -1
  });

  await assert.rejects(negativeDuration.validate());
});

test("security event rejects arbitrary unapproved fields", () => {
  assert.throws(
    () => new SecurityEvent({
      ...validEvent(),
      password: "must-never-be-stored"
    }),
    error => error.name === "StrictModeError" &&
      error.path === "password"
  );
});

test("security event validates hash-chain fields", async () => {
  const invalid = new SecurityEvent({
    ...validEvent(),
    eventHash: "not-a-hash"
  });

  await assert.rejects(invalid.validate());

  const valid = new SecurityEvent({
    ...validEvent(),
    previousHash: "a".repeat(64),
    eventHash: "b".repeat(64)
  });

  await valid.validate();
});

test("security event defines operational lookup indexes", () => {
  const indexes = SecurityEvent.schema.indexes();

  assert.ok(indexes.some(([fields]) => fields.createdAt === -1));
  assert.ok(indexes.some(([fields]) =>
    fields.userId === 1 && fields.createdAt === -1
  ));
  assert.ok(indexes.some(([fields]) =>
    fields.eventType === 1 && fields.createdAt === -1
  ));
  assert.ok(indexes.some(([fields]) =>
    fields.ipAddress === 1 && fields.createdAt === -1
  ));

  assert.ok(indexes.some(([fields, options]) =>
    fields.sequence === 1 && options.unique === true
  ));
});
