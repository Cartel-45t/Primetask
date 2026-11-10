"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const SecurityEvent = require("../src/models/SecurityEvent");

const {
  calculateEventHash,
  buildEventPayload,
  GENESIS_HASH
} = require("../src/services/securityEventChainService");

test("chain starts with a valid genesis hash", () => {
  assert.equal(GENESIS_HASH.length, 64);
  assert.match(GENESIS_HASH, /^[a-f0-9]{64}$/);
});

test("event payload includes a sequence and previous hash", () => {
  const createdAt = new Date("2026-11-09T12:00:00.000Z");

  const event = new SecurityEvent({
    eventType: "login_success",
    outcome: "success"
  });

  const payload = buildEventPayload(
    event,
    1,
    GENESIS_HASH,
    createdAt
  );

  assert.equal(payload.sequence, 1);
  assert.equal(payload.previousHash, GENESIS_HASH);
  assert.equal(payload.severity, "info");
  assert.equal(payload.createdAt, createdAt.toISOString());
});

test("event hashing is deterministic", () => {
  const payload = {
    eventType: "login_success",
    outcome: "success",
    sequence: 1,
    previousHash: GENESIS_HASH
  };

  assert.equal(
    calculateEventHash(payload),
    calculateEventHash(payload)
  );
});

test("changing event data changes its hash", () => {
  const payload = {
    eventType: "login_success",
    outcome: "success",
    sequence: 1,
    previousHash: GENESIS_HASH
  };

  const changed = {
    ...payload,
    outcome: "denied"
  };

  assert.notEqual(
    calculateEventHash(payload),
    calculateEventHash(changed)
  );
});

test("ObjectId values are normalized consistently", () => {
  const id = new mongoose.Types.ObjectId();

  const first = calculateEventHash({ userId: id });
  const second = calculateEventHash({ userId: id.toString() });

  assert.equal(first, second);
});

test("event payload preserves normalized Mongoose defaults", () => {
  const event = new SecurityEvent({
    eventType: "login_success",
    outcome: "success",
    method: "post",
    countryCode: "ke"
  });

  const payload = buildEventPayload(
    event,
    1,
    GENESIS_HASH,
    new Date("2026-11-09T12:00:00.000Z")
  );

  assert.equal(payload.severity, "info");
  assert.equal(payload.method, "POST");
  assert.equal(payload.countryCode, "KE");
});
