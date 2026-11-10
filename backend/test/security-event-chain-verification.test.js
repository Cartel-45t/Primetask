"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateEventHash,
  buildEventPayload,
  verifySecurityEventRecords,
  GENESIS_HASH
} = require("../src/services/securityEventChainService");

function makeChain(count = 2) {
  const events = [];
  let previousHash = GENESIS_HASH;

  for (let sequence = 1; sequence <= count; sequence += 1) {
    const createdAt = new Date(
      `2026-11-09T12:00:${String(sequence).padStart(2, "0")}.000Z`
    );

    const event = {
      eventType: "login_success",
      severity: "info",
      outcome: "success",
      userId: null,
      actorUserId: null,
      targetUserId: null,
      deviceId: null,
      ipAddress: null,
      countryCode: null,
      region: null,
      city: null,
      userAgent: null,
      method: null,
      path: null,
      statusCode: null,
      durationMs: null,
      requestId: null,
      message: null,
      sequence,
      previousHash,
      createdAt
    };

    event.eventHash = calculateEventHash(
      buildEventPayload(event, sequence, previousHash, createdAt)
    );

    events.push(event);
    previousHash = event.eventHash;
  }

  return {
    events,
    head: {
      sequence: events.length,
      lastHash: previousHash
    }
  };
}

test("accepts a valid two-event chain", () => {
  const { events, head } = makeChain();

  const result = verifySecurityEventRecords(events, head);

  assert.equal(result.valid, true);
  assert.equal(result.status, "valid");
  assert.equal(result.checkedEvents, 2);
});

test("accepts an empty initialized chain", () => {
  const result = verifySecurityEventRecords([], {
    sequence: 0,
    lastHash: GENESIS_HASH
  });

  assert.equal(result.valid, true);
  assert.equal(result.checkedEvents, 0);
});

test("detects changed event data", () => {
  const { events, head } = makeChain();

  events[0].outcome = "denied";

  const result = verifySecurityEventRecords(events, head);

  assert.equal(result.valid, false);
  assert.equal(result.reason, "event_hash_mismatch");
});

test("detects a broken previous-hash link", () => {
  const { events, head } = makeChain();

  events[1].previousHash = "f".repeat(64);

  const result = verifySecurityEventRecords(events, head);

  assert.equal(result.valid, false);
  assert.equal(result.reason, "previous_hash_mismatch");
});

test("detects a missing event", () => {
  const { events, head } = makeChain();

  events.splice(0, 1);

  const result = verifySecurityEventRecords(events, head);

  assert.equal(result.valid, false);
  assert.equal(result.reason, "sequence_gap_or_reordering");
});

test("detects a sequence gap", () => {
  const { events, head } = makeChain();

  events[1].sequence = 3;

  const result = verifySecurityEventRecords(events, head);

  assert.equal(result.valid, false);
  assert.equal(result.reason, "sequence_gap_or_reordering");
});

test("detects a mismatched chain head hash", () => {
  const { events, head } = makeChain();

  head.lastHash = "f".repeat(64);

  const result = verifySecurityEventRecords(events, head);

  assert.equal(result.valid, false);
  assert.equal(result.reason, "chain_head_hash_mismatch");
});

test("detects a mismatched chain head sequence", () => {
  const { events, head } = makeChain();

  head.sequence = 3;

  const result = verifySecurityEventRecords(events, head);

  assert.equal(result.valid, false);
  assert.equal(result.reason, "chain_head_sequence_mismatch");
});

test("rejects an invalid chain head", () => {
  const result = verifySecurityEventRecords([], {
    sequence: -1,
    lastHash: "invalid"
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, "invalid_chain_head");
});

test("does not modify supplied records during verification", () => {
  const { events, head } = makeChain();
  const originalHash = events[0].eventHash;

  verifySecurityEventRecords(events, head);

  assert.equal(events[0].eventHash, originalHash);
});
