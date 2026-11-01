
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createMembershipRecoveryWorker
} = require("../src/services/membershipRecoveryWorker");

const NOW = 1800000000000;

const purchase = {
  _id: "membership-1",
  paymentMethod: "daraja",
  paymentStatus: "pending",
  checkoutRequestId: "ws_CO_test123",
  merchantRequestId: "merchant-test",
  stkInitiatedAt: new Date(NOW - 5 * 60 * 1000),
  createdAt: new Date(NOW - 5 * 60 * 1000)
};

const callback = {
  _id: "callback-1",
  checkoutRequestId: purchase.checkoutRequestId,
  merchantRequestId: purchase.merchantRequestId,
  resultCode: 0,
  callbackAmountKes: 100,
  callbackReceipt: "QWE1234567",
  callbackPhoneNumber: "254700000001",
  processingStatus: "reconciliation_required"
};

function makeQuery(value) {
  return {
    sort() { return this; },
    limit() { return this; },
    lean: async () => value
  };
}

function setup({ purchases = [purchase], storedCallback = callback,
  verifyResult = { verified: true, fulfilled: true },
  verifyError = null } = {}) {
  const calls = {
    purchaseFilter: null,
    callbackFilter: null,
    purchaseUpdates: [],
    callbackUpdates: [],
    verifications: [],
    logs: []
  };

  const Purchase = {
    find(filter) {
      calls.purchaseFilter = filter;
      return makeQuery(purchases);
    },
    async updateOne(filter, update) {
      calls.purchaseUpdates.push({ filter, update });
      return { modifiedCount: 1 };
    }
  };

  const CallbackEvent = {
    findOne(filter) {
      calls.callbackFilter = filter;
      return makeQuery(storedCallback);
    },
    async updateOne(filter, update) {
      calls.callbackUpdates.push({ filter, update });
      return { modifiedCount: 1 };
    }
  };

  const worker = createMembershipRecoveryWorker({
    Purchase,
    CallbackEvent,
    verify: async args => {
      calls.verifications.push(args);
      if (verifyError) throw verifyError;
      return verifyResult;
    },
    logger: {
      info: (...args) => calls.logs.push(["info", ...args]),
      warn: (...args) => calls.logs.push(["warn", ...args]),
      error: (...args) => calls.logs.push(["error", ...args])
    },
    clock: () => NOW
  });

  return { worker, calls };
}

test("recovers a complete successful membership callback", async () => {
  const { worker, calls } = setup();

  const result = await worker.processPendingMembershipCallbacks();

  assert.equal(result.completed, 1);
  assert.equal(calls.verifications.length, 1);
  assert.equal(
    calls.verifications[0].metadata.receipt,
    callback.callbackReceipt
  );
  assert.equal(
    calls.callbackUpdates[0].update.$set.processingStatus,
    "processed"
  );
});

test("missing callback evidence never invokes verification", async () => {
  const { worker, calls } = setup({ storedCallback: null });

  const result = await worker.processPendingMembershipCallbacks();

  assert.equal(result.deferred, 1);
  assert.equal(calls.verifications.length, 0);
  assert.equal(calls.callbackUpdates.length, 0);
});

test("failed verification remains unresolved for retry", async () => {
  const { worker, calls } = setup({
    verifyResult: { verified: false, reason: "PROVIDER_CONFIRMATION_INCOMPLETE" }
  });

  const result = await worker.processPendingMembershipCallbacks();

  assert.equal(result.deferred, 1);
  assert.equal(calls.callbackUpdates[0].update.$set.processingStatus,
    "reconciliation_required");
  assert.equal(
    calls.purchaseUpdates[0].update.$set.paymentStatus,
    "verification_required"
  );
  assert.equal(calls.purchaseUpdates[0].update.$inc.reconciliationAttempts, 1);
});

test("verified payment with failed activation is not treated as unpaid", async () => {
  const { worker, calls } = setup({
    verifyResult: {
      verified: true,
      fulfilled: false,
      reason: "FULFILMENT_FAILED"
    }
  });

  const result = await worker.processPendingMembershipCallbacks();

  assert.equal(result.completed, 1);
  assert.equal(calls.purchaseUpdates.length, 0);
  assert.equal(calls.callbackUpdates[0].update.$set.processingStatus,
    "processed");
});
