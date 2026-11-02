"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createNotesPointsRecoveryWorker,
  MINIMUM_AGE_MS
} = require("../src/services/notesPointsRecoveryWorker");

const NOW = 1_800_000_000_000;

function makeQuery(value) {
  return {
    sort() { return this; },
    limit() { return this; },
    lean: async () => value
  };
}

const purchase = {
  _id: "purchase-1",
  checkoutRequestId: "ws_CO_test123",
  merchantRequestId: "merchant-test",
  paymentStatus: "pending",
  hasUnresolvedPayment: true,
  stkInitiatedAt: new Date(NOW - 5 * 60 * 1000),
  createdAt: new Date(NOW - 5 * 60 * 1000)
};

const successCallback = {
  _id: "callback-1",
  checkoutRequestId: purchase.checkoutRequestId,
  merchantRequestId: purchase.merchantRequestId,
  resultCode: 0,
  callbackAmountKes: 100,
  callbackReceipt: "QWE1234567",
  callbackPhoneNumber: "254700000001",
  processingStatus: "reconciliation_required"
};

function setup({
  purchases = [purchase],
  callback = null,
  queryResult = {
    mode: "live",
    responseCode: "0",
    resultCode: "1037",
    resultDescription: "Request still being processed",
    checkoutRequestId: purchase.checkoutRequestId
  },
  queryError = null,
  verifyResult = { verified: true },
  verifyError = null
} = {}) {
  const calls = {
    purchaseFilter: null,
    callbackFilter: null,
    purchaseUpdates: [],
    callbackUpdates: [],
    queries: [],
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
      return { acknowledged: true, modifiedCount: 1 };
    }
  };

  const DarajaCallbackEvent = {
    findOne(filter) {
      calls.callbackFilter = filter;
      return makeQuery(callback);
    },
    async updateOne(filter, update) {
      calls.callbackUpdates.push({ filter, update });
      return { acknowledged: true, modifiedCount: 1 };
    }
  };

  const worker = createNotesPointsRecoveryWorker({
    Purchase,
    DarajaCallbackEvent,
    queryProvider: async args => {
      calls.queries.push(args);
      if (queryError) throw queryError;
      return queryResult;
    },
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

test("waits at least two minutes from STK initiation", async () => {
  const { worker, calls } = setup();

  await worker.processPendingPurchases();

  assert.equal(MINIMUM_AGE_MS, 120000);
  assert.ok(
    calls.purchaseFilter.$or[0].stkInitiatedAt.$lte instanceof Date
  );
  assert.equal(
    calls.purchaseFilter.$or[0].stkInitiatedAt.$lte.getTime(),
    NOW - 120000
  );
});

test("supports older unresolved records using creation time as fallback", async () => {
  const { worker, calls } = setup();

  await worker.processPendingPurchases();

  assert.deepEqual(
    calls.purchaseFilter.$or[1],
    {
      stkInitiatedAt: null,
      createdAt: { $lte: new Date(NOW - 120000) }
    }
  );
});

test("successful provider query without callback evidence never credits Points", async () => {
  const { worker, calls } = setup({
    queryResult: {
      mode: "live",
      responseCode: "0",
      resultCode: "0",
      checkoutRequestId: purchase.checkoutRequestId
    }
  });

  const result = await worker.processPendingPurchases();

  assert.equal(result.deferred, 1);
  assert.equal(calls.verifications.length, 0);
  assert.equal(calls.purchaseUpdates[0].update.$set.hasUnresolvedPayment, undefined);
  assert.equal(
    calls.purchaseUpdates[0].update.$set.failureCode,
    "CALLBACK_EVIDENCE_MISSING"
  );
});

test("query cancellation result alone does not release the unresolved lock", async () => {
  const { worker, calls } = setup({
    queryResult: {
      mode: "live",
      responseCode: "0",
      resultCode: "1032",
      resultDescription: "Request cancelled by user",
      checkoutRequestId: purchase.checkoutRequestId
    }
  });

  const result = await worker.processPendingPurchases();

  assert.equal(result.cancelled, 0);
  assert.equal(result.deferred, 1);
  assert.equal(calls.purchaseUpdates[0].update.$set.paymentStatus, "verification_required");
  assert.equal(calls.purchaseUpdates[0].update.$set.hasUnresolvedPayment, undefined);
});

test("unknown nonzero provider result remains unresolved", async () => {
  const { worker, calls } = setup();

  const result = await worker.processPendingPurchases();

  assert.equal(result.deferred, 1);
  assert.equal(calls.purchaseUpdates[0].update.$set.paymentStatus, "verification_required");
  assert.equal(calls.purchaseUpdates[0].update.$set.hasUnresolvedPayment, undefined);
});

test("provider query error leaves purchase unresolved for another retry", async () => {
  const { worker, calls } = setup({
    queryError: new Error("Temporary Safaricom outage")
  });

  const result = await worker.processPendingPurchases();

  assert.equal(result.errors, 1);
  assert.equal(calls.purchaseUpdates.length, 1);
  assert.equal(calls.purchaseUpdates[0].update.$set.failureCode, "RECOVERY_RETRY_REQUIRED");
  assert.equal(calls.verifications.length, 0);
});

test("stored cancellation callback releases the lock without provider query", async () => {
  const { worker, calls } = setup({
    callback: {
      ...successCallback,
      resultCode: 1032,
      resultDescription: "Request cancelled by user"
    }
  });

  const result = await worker.processPendingPurchases();

  assert.equal(result.cancelled, 1);
  assert.equal(calls.queries.length, 0);
  assert.equal(calls.purchaseUpdates[0].update.$set.paymentStatus, "cancelled");
  assert.equal(calls.callbackUpdates[0].update.$set.processingStatus, "processed");
});

test("complete success callback uses verification service and marks event processed", async () => {
  const { worker, calls } = setup({
    callback: successCallback,
    queryResult: null
  });

  const result = await worker.processPendingPurchases();

  assert.equal(result.completed, 1);
  assert.equal(calls.verifications.length, 1);
  assert.deepEqual(calls.verifications[0].metadata, {
    amountKes: 100,
    receipt: "QWE1234567",
    phoneNumber: "254700000001"
  });
  assert.equal(calls.queries.length, 0);
  assert.equal(calls.callbackUpdates[0].update.$set.processingStatus, "processed");
});

test("incomplete success callback queries provider but never credits Points", async () => {
  const { worker, calls } = setup({
    callback: {
      ...successCallback,
      callbackReceipt: null
    },
    queryResult: {
      mode: "live",
      responseCode: "0",
      resultCode: "0",
      checkoutRequestId: purchase.checkoutRequestId
    }
  });

  const result = await worker.processPendingPurchases();

  assert.equal(result.deferred, 1);
  assert.equal(calls.verifications.length, 0);
  assert.equal(calls.queries.length, 1);
  assert.equal(calls.purchaseUpdates[0].update.$set.failureCode, "CALLBACK_EVIDENCE_MISSING");
});

test("failed verification keeps purchase unresolved", async () => {
  const { worker, calls } = setup({
    callback: successCallback,
    verifyResult: {
      verified: false,
      reason: "PROVIDER_CONFIRMATION_INCOMPLETE"
    }
  });

  const result = await worker.processPendingPurchases();

  assert.equal(result.deferred, 1);
  assert.equal(calls.purchaseUpdates[0].update.$set.paymentStatus, "verification_required");
  assert.equal(calls.purchaseUpdates[0].update.$set.hasUnresolvedPayment, undefined);
  assert.equal(
    calls.callbackUpdates[0].update.$set.processingStatus,
    "reconciliation_required"
  );
});

test("worker only queries existing checkout and has no STK initiation path", async () => {
  const { worker, calls } = setup();

  await worker.processPendingPurchases();

  assert.deepEqual(calls.queries, [{
    checkoutRequestId: purchase.checkoutRequestId
  }]);
  assert.equal(typeof worker.processPendingPurchases, "function");
});

test("stored non-cancellation failure callback releases the lock without provider query", async () => {
  const { worker, calls } = setup({
    callback: {
      ...successCallback,
      resultCode: 1,
      callbackAmountKes: null,
      callbackReceipt: null,
      callbackPhoneNumber: null,
      resultDescription: "Insufficient balance"
    }
  });

  const result = await worker.processPendingPurchases();

  assert.equal(result.failed, 1);
  assert.equal(calls.queries.length, 0);
  assert.equal(calls.purchaseUpdates[0].update.$set.paymentStatus, "failed");
  assert.equal(calls.purchaseUpdates[0].update.$set.hasUnresolvedPayment, false);
  assert.equal(calls.purchaseUpdates[0].update.$set.failureCode, "1");
  assert.equal(calls.callbackUpdates[0].update.$set.processingStatus, "processed");
});
