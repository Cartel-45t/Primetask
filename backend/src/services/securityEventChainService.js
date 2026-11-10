"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const SecurityEvent = require("../models/SecurityEvent");
const SecurityEventChain = require("../models/SecurityEventChain");

const CHAIN_ID = "security-events";
const GENESIS_HASH = "0".repeat(64);
const MAX_CONFLICT_RETRIES = 5;

const ALLOWED_FIELDS = [
  "eventType",
  "severity",
  "outcome",
  "userId",
  "actorUserId",
  "targetUserId",
  "deviceId",
  "ipAddress",
  "countryCode",
  "region",
  "city",
  "userAgent",
  "method",
  "path",
  "statusCode",
  "durationMs",
  "requestId",
  "message"
];

function normalizeValue(value) {
  if (value === undefined || value === null) return null;

  if (value instanceof mongoose.Types.ObjectId) {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function canonicalize(value) {
  if (
    value instanceof mongoose.Types.ObjectId ||
    value?._bsontype === "ObjectId"
  ) {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }

  return normalizeValue(value);
}

function calculateEventHash(payload) {
  const canonical = JSON.stringify(canonicalize(payload));

  return crypto
    .createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex");
}

function buildEventPayload(event, sequence, previousHash, createdAt) {
  const payload = {};

  for (const field of ALLOWED_FIELDS) {
    payload[field] = normalizeValue(event[field]);
  }

  return {
    ...payload,
    sequence,
    previousHash,
    createdAt: createdAt.toISOString()
  };
}

function isChainConflict(error) {
  return error?.code === "SECURITY_CHAIN_CONFLICT" ||
    error?.code === 11000 ||
    error?.hasErrorLabel?.("TransientTransactionError");
}

async function ensureChainHead(session = null) {
  const options = { upsert: true };

  if (session) {
    options.session = session;
  }

  await SecurityEventChain.updateOne(
    { _id: CHAIN_ID },
    {
      $setOnInsert: {
        sequence: 0,
        lastHash: GENESIS_HASH
      }
    },
    options
  );
}

async function appendSecurityEvent(eventInput, session) {
  const head = await SecurityEventChain.findById(CHAIN_ID)
    .session(session);

  if (!head) {
    throw new Error("Security event chain head is missing.");
  }

  const sequence = head.sequence + 1;
  const previousHash = head.lastHash;
  const createdAt = new Date();

  const event = new SecurityEvent({
    ...eventInput,
    sequence,
    previousHash,
    createdAt,
    updatedAt: createdAt
  });

  const payload = buildEventPayload(
    event,
    sequence,
    previousHash,
    createdAt
  );

  event.eventHash = calculateEventHash(payload);

  await event.save({ session });

  const update = await SecurityEventChain.updateOne(
    {
      _id: CHAIN_ID,
      sequence: head.sequence,
      lastHash: head.lastHash
    },
    {
      $set: {
        sequence,
        lastHash: event.eventHash
      }
    },
    { session }
  );

  if (update.modifiedCount !== 1) {
    const conflict = new Error(
      "Security chain head changed concurrently."
    );
    conflict.code = "SECURITY_CHAIN_CONFLICT";
    throw conflict;
  }

  return event;
}

async function recordSecurityEvent(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("A security event object is required.");
  }

  const eventInput = {};

  for (const field of ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      eventInput[field] = input[field];
    }
  }

  const suppliedSession = options?.session || null;

  // When a caller supplies a session, the caller owns the transaction.
  // Event insertion and chain-head advancement participate in that transaction.
  if (suppliedSession) {
    await ensureChainHead(suppliedSession);
    return appendSecurityEvent(eventInput, suppliedSession);
  }

  // Existing callers retain the original retry and session lifecycle.
  for (let attempt = 1; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
    await ensureChainHead();

    const session = await mongoose.startSession();

    try {
      let recordedEvent;

      await session.withTransaction(async () => {
        recordedEvent = await appendSecurityEvent(
          eventInput,
          session
        );
      });

      return recordedEvent;
    } catch (error) {
      if (!isChainConflict(error) || attempt === MAX_CONFLICT_RETRIES) {
        throw error;
      }
    } finally {
      await session.endSession();
    }
  }

  throw new Error("Unable to record security event after retries.");
}

function createVerificationState(head) {
  if (!head) {
    return {
      failure: {
        valid: false,
        status: "uninitialized",
        checkedEvents: 0,
        reason: "chain_head_missing"
      }
    };
  }

  if (
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 0 ||
    typeof head.lastHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(head.lastHash)
  ) {
    return {
      failure: {
        valid: false,
        status: "corrupt",
        checkedEvents: 0,
        reason: "invalid_chain_head"
      }
    };
  }

  return {
    head,
    checkedEvents: 0,
    previousHash: GENESIS_HASH,
    lastHash: GENESIS_HASH,
    failure: null
  };
}

function verifyNextEvent(state, event) {
  if (state.failure) return state.failure;

  const expectedSequence = state.checkedEvents + 1;

  if (event.sequence !== expectedSequence) {
    state.failure = {
      valid: false,
      status: "corrupt",
      checkedEvents: state.checkedEvents,
      reason: "sequence_gap_or_reordering",
      expectedSequence,
      actualSequence: event.sequence ?? null
    };
    return state.failure;
  }

  if (event.previousHash !== state.previousHash) {
    state.failure = {
      valid: false,
      status: "corrupt",
      checkedEvents: state.checkedEvents,
      reason: "previous_hash_mismatch",
      sequence: event.sequence
    };
    return state.failure;
  }

  const createdAt = event.createdAt instanceof Date
    ? event.createdAt
    : new Date(event.createdAt);

  if (Number.isNaN(createdAt.getTime())) {
    state.failure = {
      valid: false,
      status: "corrupt",
      checkedEvents: state.checkedEvents,
      reason: "invalid_event_timestamp",
      sequence: event.sequence
    };
    return state.failure;
  }

  if (
    typeof event.eventHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(event.eventHash)
  ) {
    state.failure = {
      valid: false,
      status: "corrupt",
      checkedEvents: state.checkedEvents,
      reason: "invalid_event_hash_format",
      sequence: event.sequence
    };
    return state.failure;
  }

  const payload = buildEventPayload(
    event,
    event.sequence,
    event.previousHash,
    createdAt
  );

  const calculatedHash = calculateEventHash(payload);

  if (calculatedHash !== event.eventHash) {
    state.failure = {
      valid: false,
      status: "corrupt",
      checkedEvents: state.checkedEvents,
      reason: "event_hash_mismatch",
      sequence: event.sequence
    };
    return state.failure;
  }

  state.checkedEvents += 1;
  state.previousHash = event.eventHash;
  state.lastHash = event.eventHash;

  return null;
}

function finishVerification(state) {
  if (state.failure) return state.failure;

  if (state.checkedEvents !== state.head.sequence) {
    return {
      valid: false,
      status: "corrupt",
      checkedEvents: state.checkedEvents,
      reason: "chain_head_sequence_mismatch",
      expectedSequence: state.head.sequence,
      actualSequence: state.checkedEvents
    };
  }

  if (state.lastHash !== state.head.lastHash) {
    return {
      valid: false,
      status: "corrupt",
      checkedEvents: state.checkedEvents,
      reason: "chain_head_hash_mismatch"
    };
  }

  return {
    valid: true,
    status: "valid",
    checkedEvents: state.checkedEvents,
    sequence: state.head.sequence,
    lastHash: state.head.lastHash
  };
}

function verifySecurityEventRecords(events, head) {
  if (!Array.isArray(events)) {
    throw new TypeError("Security event records must be an array.");
  }

  const state = createVerificationState(head);
  if (state.failure) return state.failure;

  for (const event of events) {
    const failure = verifyNextEvent(state, event);
    if (failure) return failure;
  }

  return finishVerification(state);
}

async function verifySecurityEventChain() {
  const MAX_VERIFY_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt += 1) {
    const head = await SecurityEventChain.findById(CHAIN_ID).lean();

    if (!head) {
      return {
        valid: false,
        status: "uninitialized",
        checkedEvents: 0,
        reason: "chain_head_missing"
      };
    }

    const state = createVerificationState(head);
    if (state.failure) return state.failure;

    const cursor = SecurityEvent.find({
      sequence: { $lte: head.sequence }
    })
      .sort({ sequence: 1 })
      .lean()
      .cursor({ batchSize: 500 });

    try {
      for await (const event of cursor) {
        const failure = verifyNextEvent(state, event);
        if (failure) return failure;
      }
    } finally {
      await cursor.close();
    }

    const headAfterScan =
      await SecurityEventChain.findById(CHAIN_ID).lean();

    if (
      !headAfterScan ||
      headAfterScan.sequence !== head.sequence ||
      headAfterScan.lastHash !== head.lastHash
    ) {
      continue;
    }

    const unexpectedEvent = await SecurityEvent.findOne({
      sequence: { $gt: head.sequence }
    })
      .sort({ sequence: 1 })
      .select({ sequence: 1 })
      .lean();

    const confirmedHead =
      await SecurityEventChain.findById(CHAIN_ID).lean();

    if (
      !confirmedHead ||
      confirmedHead.sequence !== head.sequence ||
      confirmedHead.lastHash !== head.lastHash
    ) {
      continue;
    }

    if (unexpectedEvent) {
      return {
        valid: false,
        status: "corrupt",
        checkedEvents: state.expectedSequence - 1,
        reason: "unexpected_events_after_chain_head",
        sequence: unexpectedEvent.sequence
      };
    }

    return finishVerification(state);
  }

  return {
    valid: false,
    status: "unstable",
    checkedEvents: 0,
    reason: "chain_changed_during_verification"
  };
}

module.exports = {
  recordSecurityEvent,
  calculateEventHash,
  buildEventPayload,
  verifySecurityEventRecords,
  verifySecurityEventChain,
  GENESIS_HASH
};
