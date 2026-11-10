"use strict";

require("dotenv").config({
  path: require("node:path").resolve(__dirname, "../.env")
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const SecurityEvent = require("../src/models/SecurityEvent");
const SecurityEventChain = require("../src/models/SecurityEventChain");

const {
  recordSecurityEvent,
  verifySecurityEventChain
} = require("../src/services/securityEventChainService");

const enabled = process.env.PTW_SECURITY_CHAIN_INTEGRATION === "1";

test(
  "MongoDB security chain transactions, concurrency and tamper detection",
  { skip: !enabled },
  async () => {
    const uri = process.env.MONGODB_URI;

    assert.ok(uri, "MONGODB_URI must be configured.");

    const testDatabase =
      `ptw_sct_${process.pid}_${Date.now().toString(36)}`;

    let connected = false;

    try {
      await mongoose.connect(uri, {
        dbName: testDatabase,
        serverSelectionTimeoutMS: 15000
      });

      connected = true;

      assert.equal(
        mongoose.connection.name,
        testDatabase,
        "Connection must use the isolated test database."
      );

      await SecurityEvent.init();
      await SecurityEventChain.init();

      const eventIndexes = await SecurityEvent.collection.indexes();

      const uniqueSequenceIndex = eventIndexes.find(index =>
        index.key?.sequence === 1 && index.unique === true
      );

      assert.ok(
        uniqueSequenceIndex,
        "MongoDB must enforce unique event sequences."
      );

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          recordSecurityEvent({
            eventType: "login_success",
            outcome: "success",
            message: `Integration test event ${index + 1}`
          })
        )
      );

      assert.equal(results.length, 5);

      const events = await SecurityEvent.find({})
        .sort({ sequence: 1 })
        .lean();

      assert.equal(events.length, 5);

      assert.deepEqual(
        events.map(event => event.sequence),
        [1, 2, 3, 4, 5]
      );

      const verification = await verifySecurityEventChain();

      assert.equal(verification.valid, true);
      assert.equal(verification.checkedEvents, 5);

      // Simulate an out-of-band database insertion beyond the recorded head.
      await SecurityEvent.collection.insertOne({
        sequence: 6,
        previousHash: "0".repeat(64),
        eventHash: "a".repeat(64),
        eventType: "login_success",
        severity: "warning",
        outcome: "success",
        createdAt: new Date(),
        updatedAt: new Date()
      });

      const extraEventVerification = await verifySecurityEventChain();

      assert.equal(extraEventVerification.valid, false);
      assert.equal(
        extraEventVerification.reason,
        "unexpected_events_after_chain_head"
      );
      assert.equal(extraEventVerification.sequence, 6);

      await SecurityEvent.collection.deleteOne({ sequence: 6 });

      const restoredVerification = await verifySecurityEventChain();
      assert.equal(restoredVerification.valid, true);
      assert.equal(restoredVerification.checkedEvents, 5);

      // A caller-owned transaction must roll back both the event
      // and the chain head when the surrounding operation aborts.
      const headBeforeRollback =
        await SecurityEventChain.findById("security-events").lean();

      assert.ok(headBeforeRollback);

      const rollbackSession = await mongoose.startSession();

      try {
        await assert.rejects(
          rollbackSession.withTransaction(async () => {
            await recordSecurityEvent(
              {
                eventType: "admin_security_action",
                severity: "warning",
                outcome: "failed",
                message: "Intentional transaction rollback test."
              },
              { session: rollbackSession }
            );

            throw new Error("INTENTIONAL_TEST_ROLLBACK");
          }),
          /INTENTIONAL_TEST_ROLLBACK/
        );
      } finally {
        await rollbackSession.endSession();
      }

      const eventsAfterRollback = await SecurityEvent.find({})
        .sort({ sequence: 1 })
        .lean();

      const headAfterRollback =
        await SecurityEventChain.findById("security-events").lean();

      assert.equal(eventsAfterRollback.length, 5);
      assert.equal(headAfterRollback.sequence, headBeforeRollback.sequence);
      assert.equal(headAfterRollback.lastHash, headBeforeRollback.lastHash);

      const rollbackVerification = await verifySecurityEventChain();

      assert.equal(rollbackVerification.valid, true);
      assert.equal(rollbackVerification.checkedEvents, 5);

      const firstEvent = events[0];

      await SecurityEvent.updateOne(
        { _id: firstEvent._id },
        { $set: { outcome: "denied" } }
      );

      const tamperedVerification = await verifySecurityEventChain();

      assert.equal(tamperedVerification.valid, false);
      assert.equal(tamperedVerification.reason, "event_hash_mismatch");
      assert.equal(tamperedVerification.sequence, 1);
    } finally {
      if (connected) {
        try {
          await mongoose.connection.dropDatabase();
        } finally {
          await mongoose.disconnect();
        }
      }
    }
  }
);
