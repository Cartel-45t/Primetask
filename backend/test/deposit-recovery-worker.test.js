"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createDepositRecoveryWorker
} = require("../src/services/depositRecoveryWorker");

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

function setup({ deposits = [], callback = null, verify } = {}) {
  const calls = {
    verification: [],
    callbackUpdates: [],
    depositUpdates: [],
    logs: []
  };

  const Deposit = {
    find(filter) {
      calls.depositFilter = filter;
      return makeQuery(deposits);
    },
    async updateOne(filter, update) {
      calls.depositUpdates.push({ filter, update });
      return { acknowledged: true };
    }
  };

  const DarajaCallbackEvent = {
    findOne(filter) {
      calls.callbackFilter = filter;
      return makeQuery(callback);
    },
    async updateOne(filter, update) {
      calls.callbackUpdates.push({ filter, update });
      return { acknowledged: true };
    }
  };

  const worker = createDepositRecoveryWorker({
    Deposit,
    DarajaCallbackEvent,
    verifyAndCompleteDepositCallback: async args => {
      calls.verification.push(args);
      if (verify) return verify(args);
      return { status: "completed" };
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

const deposit = {
  _id: "deposit-id",
  requestId: "DP-TEST-123456",
  checkoutRequestId: "ws_CO_test123",
  merchantRequestId: "merchant-test",
  status: "pending",
  paymentMode: "daraja"
};

const callback = {
  _id: "callback-id",
  checkoutRequestId: deposit.checkoutRequestId,
  merchantRequestId: deposit.merchantRequestId,
  resultCode: 0,
  callbackAmountKes: 785,
  callbackReceipt: "QWE1234567",
  callbackPhoneNumber: "254700000001",
  processingStatus: "reconciliation_required"
};

test("recovers a stored successful callback through independent verification", async () => {
  const { worker, calls } = setup({
    deposits: [deposit],
    callback
  });

  const result = await worker.processPendingDepositCallbacks();

  assert.equal(result.examined, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.errors, 0);
  assert.equal(calls.verification.length, 1);

  assert.deepEqual(calls.verification[0], {
    requestId: deposit.requestId,
    checkoutRequestId: deposit.checkoutRequestId,
    merchantRequestId: callback.merchantRequestId,
    resultCode: 0,
    metadata: {
      amountKes: 785,
      receipt: "QWE1234567",
      phoneNumber: "254700000001"
    },
    ipAddress: "background-recovery-worker"
  });

  assert.equal(calls.callbackUpdates.length, 1);
  assert.equal(
    calls.callbackUpdates[0].update.$set.processingStatus,
    "processed"
  );
});

test("does not attempt verification when complete callback evidence is missing", async () => {
  const { worker, calls } = setup({
    deposits: [deposit],
    callback: null
  });

  const result = await worker.processPendingDepositCallbacks();

  assert.equal(result.examined, 1);
  assert.equal(result.deferred, 1);
  assert.equal(result.completed, 0);
  assert.equal(calls.verification.length, 0);
  assert.equal(calls.callbackUpdates.length, 0);
});

test("leaves failed verification unresolved and schedules safe retry state", async () => {
  const { worker, calls } = setup({
    deposits: [deposit],
    callback,
    verify: async () => {
      throw new Error("Safaricom did not independently confirm payment");
    }
  });

  const result = await worker.processPendingDepositCallbacks();

  assert.equal(result.examined, 1);
  assert.equal(result.completed, 0);
  assert.equal(result.errors, 1);
  assert.equal(calls.verification.length, 1);

  assert.equal(
    calls.callbackUpdates[0].update.$set.processingStatus,
    "reconciliation_required"
  );

  assert.match(
    calls.depositUpdates[0].update.$set.resultDescription,
    /Safaricom did not independently confirm payment/
  );
});

test("processes no deposits when the pending Daraja query returns none", async () => {
  const { worker, calls } = setup({ deposits: [] });

  const result = await worker.processPendingDepositCallbacks();

  assert.equal(result.examined, 0);
  assert.equal(result.completed, 0);
  assert.equal(calls.verification.length, 0);
});

test("queries only pending Daraja deposits with recorded checkout IDs", async () => {
  const { worker, calls } = setup({ deposits: [] });

  await worker.processPendingDepositCallbacks();

  assert.equal(calls.depositFilter.status, "pending");
  assert.equal(calls.depositFilter.paymentMode, "daraja");
  assert.deepEqual(
    calls.depositFilter.checkoutRequestId,
    { $type: "string" }
  );
});
