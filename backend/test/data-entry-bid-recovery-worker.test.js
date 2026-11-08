"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createDataEntryBidRecoveryWorker,
  MINIMUM_AGE_MS
} = require("../src/services/dataEntryBidRecoveryWorker");

const NOW = 1_800_000_000_000;

function makeQuery(value) {
  return {
    sort() { return this; },
    limit() { return this; },
    lean: async () => value
  };
}

const purchase = {
  _id: "data-entry-purchase-1",
  checkoutRequestId: "ws_CO_data_entry_test",
  merchantRequestId: "merchant-data-entry-test",
  paymentStatus: "pending",
  hasUnresolvedPayment: true,
  stkInitiatedAt: new Date(NOW - 5 * 60 * 1000),
  createdAt: new Date(NOW - 5 * 60 * 1000)
};

const successCallback = {
  _id: "callback-data-entry-1",
  checkoutRequestId: purchase.checkoutRequestId,
  merchantRequestId: purchase.merchantRequestId,
  resultCode: 0,
  resultDescription: "The service request is processed successfully.",
  callbackAmountKes: 250,
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

  const worker = createDataEntryBidRecoveryWorker({
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

test("waits at least two minutes after STK initiation", async () => {
  const { worker, calls } = setup();

  await worker.processPendingPurchases();

  assert.equal(MINIMUM_AGE_MS, 120000);

  assert.equal(
    calls.purchaseFilter.$or[0].stkInitiatedAt.$lte.getTime(),
    NOW - 120000
  );

  assert.equal(
    calls.purchaseFilter.$or[1].createdAt.$lte.getTime(),
    NOW - 120000
  );
});

test("only searches unresolved purchases with both Daraja request IDs", async () => {
  const { worker, calls } = setup();

  await worker.processPendingPurchases();

  assert.equal(
    calls.purchaseFilter.hasUnresolvedPayment,
    true
  );

  assert.deepEqual(
    calls.purchaseFilter.paymentStatus,
    { $in: ["pending", "verification_required"] }
  );

  assert.deepEqual(
    calls.purchaseFilter.checkoutRequestId,
    { $type: "string" }
  );

  assert.deepEqual(
    calls.purchaseFilter.merchantRequestId,
    { $type: "string" }
  );
});

test("complete success callback uses verification service and marks callback processed", async () => {
  const { worker, calls } = setup({
    callback: successCallback,
    queryResult: null
  });

  const result = await worker.processPendingPurchases();

  assert.equal(result.examined, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.deferred, 0);

  assert.equal(calls.verifications.length, 1);

  assert.deepEqual(calls.verifications[0], {
    purchaseId: purchase._id,
    checkoutRequestId: purchase.checkoutRequestId,
    merchantRequestId: purchase.merchantRequestId,
    resultCode: 0,
    metadata: {
      amountKes: 250,
      receipt: "QWE1234567",
      phoneNumber: "254700000001"
    }
  });

  assert.equal(calls.queries.length, 0);

  assert.equal(
    calls.callbackUpdates[0].update.$set.processingStatus,
    "processed"
  );
});

test("confirmed cancellation callback releases unresolved lock", async () => {
  const { worker, calls } = setup({
    callback: {
      ...successCallback,
      resultCode: 1032,
      resultDescription: "Request cancelled by user",
      callbackAmountKes: null,
      callbackReceipt: null,
      callbackPhoneNumber: null
    }
  });

  const result = await worker.processPendingPurchases();

  assert.equal(result.cancelled, 1);
  assert.equal(result.deferred, 0);
  assert.equal(calls.queries.length, 0);
  assert.equal(calls.verifications.length, 0);

  assert.equal(
    calls.purchaseUpdates[0].update.$set.paymentStatus,
    "cancelled"
  );

  assert.equal(
    calls.purchaseUpdates[0].update.$set.hasUnresolvedPayment,
    false
  );

  assert.equal(
    calls.callbackUpdates[0].update.$set.processingStatus,
    "processed"
  );
});

test("confirmed non-cancellation failure releases unresolved lock", async () => {
  const { worker, calls } = setup({
    callback: {
      ...successCallback,
      resultCode: 1,
      resultDescription: "Insufficient balance",
      callbackAmountKes: null,
      callbackReceipt: null,
      callbackPhoneNumber: null
    }
  });

  const result = await worker.processPendingPurchases();

  assert.equal(result.failed, 1);
  assert.equal(result.cancelled, 0);
  assert.equal(calls.queries.length, 0);

  assert.equal(
    calls.purchaseUpdates[0].update.$set.paymentStatus,
    "failed"
  );

  assert.equal(
    calls.purchaseUpdates[0].update.$set.hasUnresolvedPayment,
    false
  );

  assert.equal(
    calls.purchaseUpdates[0].update.$set.failureCode,
    "1"
  );

  assert.equal(
    calls.callbackUpdates[0].update.$set.processingStatus,
    "processed"
  );
});

test("successful provider query without callback evidence never credits bids", async () => {
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
  assert.equal(calls.queries.length, 1);

  assert.equal(
    calls.purchaseUpdates[0].update.$set.failureCode,
    "CALLBACK_EVIDENCE_MISSING"
  );

  assert.equal(
    calls.purchaseUpdates[0].update.$set.hasUnresolvedPayment,
    undefined
  );
});

test("incomplete success callback cannot credit bids", async () => {
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

  assert.equal(
    calls.callbackUpdates[0].update.$set.processingStatus,
    "reconciliation_required"
  );
});

test("failed independent verification keeps purchase unresolved", async () => {
  const { worker, calls } = setup({
    callback: successCallback,
    queryResult: null,
    verifyResult: {
      verified: false,
      reason: "PROVIDER_CONFIRMATION_INCOMPLETE"
    }
  });

  const result = await worker.processPendingPurchases();

  assert.equal(result.deferred, 1);
  assert.equal(calls.verifications.length, 1);

  assert.equal(
    calls.purchaseUpdates[0].update.$set.paymentStatus,
    "verification_required"
  );

  assert.equal(
    calls.purchaseUpdates[0].update.$set.hasUnresolvedPayment,
    undefined
  );

  assert.equal(
    calls.callbackUpdates[0].update.$set.processingStatus,
    "reconciliation_required"
  );
});

test("provider query error leaves purchase unresolved for retry", async () => {
  const { worker, calls } = setup({
    queryError: new Error("Temporary Safaricom outage")
  });

  const result = await worker.processPendingPurchases();

  assert.equal(result.errors, 1);
  assert.equal(calls.purchaseUpdates.length, 1);
  assert.equal(calls.verifications.length, 0);

  assert.equal(
    calls.purchaseUpdates[0].update.$set.failureCode,
    "RECOVERY_RETRY_REQUIRED"
  );

  assert.equal(
    calls.purchaseUpdates[0].update.$set.hasUnresolvedPayment,
    undefined
  );
});

test("callback lookup requires matching checkout and merchant IDs", async () => {
  const { worker, calls } = setup();

  await worker.processPendingPurchases();

  assert.deepEqual(calls.callbackFilter, {
    checkoutRequestId: purchase.checkoutRequestId,
    merchantRequestId: purchase.merchantRequestId,
    processingStatus: {
      $in: ["received", "reconciliation_required"]
    }
  });
});

test("purchase updates require matching request IDs and unresolved status", async () => {
  const { worker, calls } = setup();

  await worker.processPendingPurchases();

  assert.equal(
    calls.purchaseUpdates[0].filter.checkoutRequestId,
    purchase.checkoutRequestId
  );

  assert.equal(
    calls.purchaseUpdates[0].filter.merchantRequestId,
    purchase.merchantRequestId
  );

  assert.deepEqual(
    calls.purchaseUpdates[0].filter.paymentStatus,
    { $in: ["pending", "verification_required"] }
  );

  assert.equal(
    calls.purchaseUpdates[0].filter.hasUnresolvedPayment,
    true
  );
});

test("worker prevents overlapping recovery runs", async () => {
  let releaseQuery;

  const Purchase = {
    find() {
      return {
        sort() { return this; },
        limit() { return this; },
        lean: () => new Promise(resolve => {
          releaseQuery = () => resolve([]);
        })
      };
    }
  };

  const worker = createDataEntryBidRecoveryWorker({
    Purchase,
    DarajaCallbackEvent: {},
    queryProvider: async () => null,
    verify: async () => ({ verified: true }),
    logger: { info() {}, warn() {}, error() {} },
    clock: () => NOW
  });

  const firstRun = worker.processPendingPurchases();
  const secondRun = await worker.processPendingPurchases();

  assert.equal(secondRun.skipped, true);

  releaseQuery();

  const firstResult = await firstRun;

  assert.equal(firstResult.examined, 0);
});

test("worker has no STK initiation path", async () => {
  const { worker, calls } = setup();

  await worker.processPendingPurchases();

  assert.deepEqual(calls.queries, [{
    checkoutRequestId: purchase.checkoutRequestId
  }]);

  assert.equal(
    typeof worker.processPendingPurchases,
    "function"
  );

  assert.equal(
    typeof worker.startDataEntryBidRecoveryWorker,
    "function"
  );

  assert.equal(
    typeof worker.stopDataEntryBidRecoveryWorker,
    "function"
  );
});
