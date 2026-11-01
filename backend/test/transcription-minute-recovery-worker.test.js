"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createTranscriptionMinuteRecoveryWorker
} = require("../src/services/transcriptionMinuteRecoveryWorker");

function makeQuery(value) {
  return {
    sort() {
      return this;
    },
    limit() {
      return this;
    },
    lean: async () => value
  };
}

function setup({ purchases = [], callback = null, verify } = {}) {
  const calls = {
    verification: [],
    callbackUpdates: [],
    purchaseUpdates: [],
    logs: []
  };

  const Purchase = {
    find(filter) {
      calls.purchaseFilter = filter;
      return makeQuery(purchases);
    },
    async updateOne(filter, update) {
      calls.purchaseUpdates.push({ filter, update });
      return { acknowledged: true };
    }
  };

  const CallbackEvent = {
    findOne(filter) {
      calls.callbackFilter = filter;
      return makeQuery(callback);
    },
    async updateOne(filter, update) {
      calls.callbackUpdates.push({ filter, update });
      return { acknowledged: true };
    }
  };

  const worker = createTranscriptionMinuteRecoveryWorker({
    Purchase,
    CallbackEvent,
    verify: async args => {
      calls.verification.push(args);
      if (verify) return verify(args);
      return { verified: true };
    },
    logger: {
      info: (...args) => calls.logs.push(["info", ...args]),
      warn: (...args) => calls.logs.push(["warn", ...args]),
      error: (...args) => calls.logs.push(["error", ...args])
    },
    clock: () => 1_800_000_000_000
  });

  return { worker, calls };
}

const purchase = {
  _id: "minute-purchase-id",
  checkoutRequestId: "ws_CO_minute_test",
  merchantRequestId: "merchant-minute-test",
  paymentStatus: "verification_required"
};

const callback = {
  _id: "minute-callback-id",
  checkoutRequestId: purchase.checkoutRequestId,
  merchantRequestId: purchase.merchantRequestId,
  resultCode: 0,
  callbackAmountKes: 1300,
  callbackReceipt: "ABC1234567",
  callbackPhoneNumber: "254700000001",
  processingStatus: "reconciliation_required"
};

test("recovers a complete successful transcription minute callback", async () => {
  const { worker, calls } = setup({
    purchases: [purchase],
    callback
  });

  const result = await worker.processPendingMinuteCallbacks();

  assert.equal(result.examined, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.errors, 0);
  assert.equal(calls.verification.length, 1);

  assert.deepEqual(calls.verification[0], {
    purchaseId: purchase._id,
    checkoutRequestId: purchase.checkoutRequestId,
    merchantRequestId: callback.merchantRequestId,
    resultCode: 0,
    metadata: {
      amountKes: 1300,
      receipt: "ABC1234567",
      phoneNumber: "254700000001"
    }
  });

  assert.equal(calls.callbackUpdates.length, 1);
  assert.equal(
    calls.callbackUpdates[0].update.$set.processingStatus,
    "processed"
  );
  assert.equal(calls.purchaseUpdates.length, 0);
});

test("does not verify or credit when complete callback evidence is missing", async () => {
  const { worker, calls } = setup({
    purchases: [purchase],
    callback: null
  });

  const result = await worker.processPendingMinuteCallbacks();

  assert.equal(result.examined, 1);
  assert.equal(result.deferred, 1);
  assert.equal(result.completed, 0);
  assert.equal(calls.verification.length, 0);
  assert.equal(calls.callbackUpdates.length, 0);
  assert.equal(calls.purchaseUpdates.length, 0);
});

test("keeps a purchase unresolved when provider verification is incomplete", async () => {
  const { worker, calls } = setup({
    purchases: [purchase],
    callback,
    verify: async () => ({
      verified: false,
      reason: "PROVIDER_CONFIRMATION_INCOMPLETE"
    })
  });

  const result = await worker.processPendingMinuteCallbacks();

  assert.equal(result.examined, 1);
  assert.equal(result.deferred, 1);
  assert.equal(result.completed, 0);
  assert.equal(calls.verification.length, 1);

  assert.equal(
    calls.callbackUpdates[0].update.$set.processingStatus,
    "reconciliation_required"
  );

  assert.equal(
    calls.purchaseUpdates[0].update.$set.paymentStatus,
    "verification_required"
  );
  assert.equal(
    calls.purchaseUpdates[0].update.$set.failureCode,
    "PROVIDER_CONFIRMATION_INCOMPLETE"
  );
});

test("keeps callback evidence available for retry when verification throws", async () => {
  const { worker, calls } = setup({
    purchases: [purchase],
    callback,
    verify: async () => {
      throw new Error("Safaricom confirmation unavailable");
    }
  });

  const result = await worker.processPendingMinuteCallbacks();

  assert.equal(result.examined, 1);
  assert.equal(result.errors, 1);
  assert.equal(result.completed, 0);
  assert.equal(calls.verification.length, 1);
  assert.equal(
    calls.callbackUpdates[0].update.$set.processingStatus,
    "reconciliation_required"
  );
});

test("processes no purchases when there are no pending minute records", async () => {
  const { worker, calls } = setup({ purchases: [] });

  const result = await worker.processPendingMinuteCallbacks();

  assert.equal(result.examined, 0);
  assert.equal(result.completed, 0);
  assert.equal(calls.verification.length, 0);
});

test("queries unresolved purchases using STK timestamp with legacy fallback", async () => {
  const { worker, calls } = setup({ purchases: [] });

  await worker.processPendingMinuteCallbacks();

  const cutoff = new Date(1_800_000_000_000 - 60_000);

  assert.deepEqual(calls.purchaseFilter.paymentStatus, {
    $in: ["pending", "verification_required"]
  });
  assert.deepEqual(calls.purchaseFilter.checkoutRequestId, {
    $type: "string"
  });
  assert.deepEqual(calls.purchaseFilter.merchantRequestId, {
    $type: "string"
  });
  assert.deepEqual(calls.purchaseFilter.$or, [
    {
      stkInitiatedAt: {
        $type: "date",
        $lte: cutoff
      }
    },
    {
      stkInitiatedAt: null,
      updatedAt: {
        $lte: cutoff
      }
    }
  ]);
});
