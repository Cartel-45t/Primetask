"use strict";

const { test, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const Module = require("node:module");

const TOKEN = "test-only-b2c-callback-token-0123456789";
const ORIGINATOR = "PTWB2C_TEST_123456";
const RECEIPT = "QWE1234567";
const USER_ID = "111111111111111111111111";
const REQUEST_ID = "PTW-WCAB12CD34";

let server;
let baseUrl;
let router;
let state;

const originalLoad = Module._load;

function snapshot() {
  return structuredClone(state);
}

function restore(saved) {
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, saved);
}

const mongooseMock = {
  async startSession() {
    return {
      async withTransaction(callback) {
        const saved = snapshot();
        try {
          await callback();
        } catch (error) {
          restore(saved);
          throw error;
        }
      },
      async endSession() {}
    };
  }
};

const withdrawalModel = {
  findOne(query) {
    return {
      session: async () => {
        const item = state.withdrawal;
        if (
          !item ||
          item.b2cOriginatorConversationId !==
            query.b2cOriginatorConversationId
        ) return null;
        return { ...item };
      }
    };
  },

  async updateOne(filter, update) {
    const item = state.withdrawal;
    if (!item) return { matchedCount: 0, modifiedCount: 0 };

    if (
      filter.b2cOriginatorConversationId &&
      item.b2cOriginatorConversationId !==
        filter.b2cOriginatorConversationId
    ) return { matchedCount: 0, modifiedCount: 0 };

    if (
      filter._id &&
      String(item._id) !== String(filter._id)
    ) return { matchedCount: 0, modifiedCount: 0 };

    if (
      filter.status &&
      !(Array.isArray(filter.status.$in)
        ? filter.status.$in.includes(item.status)
        : filter.status === item.status)
    ) return { matchedCount: 0, modifiedCount: 0 };

    Object.assign(item, update.$set || {});
    return { matchedCount: 1, modifiedCount: 1 };
  }
};

const eventModel = {
  async create(record) {
    const existing = state.events.find(
      item => item.eventKey === record.eventKey
    );
    if (existing) {
      const error = new Error("Duplicate event");
      error.code = 11000;
      throw error;
    }

    const event = { _id: `event-${state.events.length + 1}`, ...record };
    state.events.push(event);
    return event;
  },

  async findOne(query) {
    return state.events.find(
      item => item.eventKey === query.eventKey
    ) || null;
  },

  async updateOne(filter, update) {
    const event = state.events.find(
      item => String(item._id) === String(filter._id)
    );
    if (!event) return { matchedCount: 0, modifiedCount: 0 };

    Object.assign(event, update.$set || {});
    return { matchedCount: 1, modifiedCount: 1 };
  }
};

const receiptClaimModel = {
  async create(records) {
    for (const record of records) {
      if (state.claims.some(item => item.receipt === record.receipt)) {
        const error = new Error("Receipt already claimed");
        error.code = 11000;
        throw error;
      }
    }

    state.claims.push(...structuredClone(records));
    return records;
  }
};

const walletModel = {
  async updateOne(filter, update) {
    if (
      !state.wallet ||
      state.wallet.userId !== filter.userId ||
      state.wallet.currency !== filter.currency
    ) return { matchedCount: 0, modifiedCount: 0 };

    state.wallet.totalWithdrawalsCents +=
      update.$inc.totalWithdrawalsCents;
    return { matchedCount: 1, modifiedCount: 1 };
  }
};

const ledgerModel = {
  async updateOne(filter, update) {
    const ledger = state.ledger;
    if (
      !ledger ||
      String(ledger._id) !== String(filter._id) ||
      ledger.userId !== filter.userId ||
      ledger.type !== filter.type ||
      ledger.status !== filter.status ||
      ledger.amountCents !== filter.amountCents
    ) return { matchedCount: 0, modifiedCount: 0 };

    Object.assign(ledger, update.$set || {});
    return { matchedCount: 1, modifiedCount: 1 };
  }
};

function loadRouteWithMocks() {
  Module._load = function (request, parent, isMain) {
    if (request === "mongoose") return mongooseMock;
    if (request === "../models/Withdrawal") return withdrawalModel;
    if (request === "../models/DarajaB2CCallbackEvent") return eventModel;
    if (request === "../models/MpesaReceiptClaim") return receiptClaimModel;
    if (request === "../models/Wallet") return walletModel;
    if (request === "../models/WalletTransaction") return ledgerModel;

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const routePath = require.resolve("../src/routes/darajaB2CCallbacks");
    delete require.cache[routePath];
    router = require(routePath);
  } finally {
    Module._load = originalLoad;
  }
}

function resetState() {
  state = {
    withdrawal: {
      _id: "withdrawal-1",
      requestId: REQUEST_ID,
      userId: USER_ID,
      amountCents: 785,
      payoutAmountKes: 1000,
      transactionId: "ledger-1",
      status: "processing",
      b2cOriginatorConversationId: ORIGINATOR,
      b2cInitiationState: "accepted",
      mpesaReceipt: null
    },
    wallet: {
      userId: USER_ID,
      currency: "USD",
      totalWithdrawalsCents: 0
    },
    ledger: {
      _id: "ledger-1",
      userId: USER_ID,
      type: "withdrawal",
      status: "pending",
      amountCents: 785
    },
    claims: [],
    events: []
  };
}

function payload({
  resultCode = 0,
  amount = 1000,
  receipt = RECEIPT,
  originator = ORIGINATOR
} = {}) {
  return {
    Result: {
      OriginatorConversationID: originator,
      ConversationID: "AG_TEST_CONVERSATION",
      ResultCode: resultCode,
      ResultDesc: resultCode === 0 ? "The service request is processed successfully." : "Request failed",
      ResultParameters: {
        ResultParameter: [
          { Key: "TransactionAmount", Value: amount },
          { Key: "TransactionReceipt", Value: receipt },
          { Key: "ReceiverPartyPublicName", Value: "254712345678 - TEST USER" },
          { Key: "TransactionCompletedDateTime", Value: "20261025123000" }
        ]
      }
    }
  };
}

async function sendCallback(type, body, token = TOKEN) {
  return fetch(`${baseUrl}/${type}?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

before(() => {
  process.env.DARAJA_B2C_CALLBACK_TOKEN = TOKEN;
  loadRouteWithMocks();
});

beforeEach(async () => {
  resetState();

  const app = express();
  app.use(express.json());
  app.use("/", router);

  server = http.createServer(app);
  await new Promise(resolve =>
    server.listen(0, "127.0.0.1", resolve)
  );
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve())
  );
  server = null;
});

test("successful callback completes withdrawal accounting once", async () => {
  const response = await sendCallback("result", payload());

  assert.equal(response.status, 200);
  assert.equal(state.withdrawal.status, "paid");
  assert.equal(state.withdrawal.b2cInitiationState, "succeeded");
  assert.equal(state.withdrawal.mpesaReceipt, RECEIPT);
  assert.equal(state.wallet.totalWithdrawalsCents, 785);
  assert.equal(state.ledger.status, "completed");
  assert.equal(state.claims.length, 1);
  assert.equal(state.claims[0].receipt, RECEIPT);
  assert.equal(state.events[0].processingStatus, "processed");
});

test("duplicate successful callback does not double-count the withdrawal", async () => {
  const body = payload();

  const first = await sendCallback("result", body);
  const second = await sendCallback("result", body);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(state.withdrawal.status, "paid");
  assert.equal(state.wallet.totalWithdrawalsCents, 785);
  assert.equal(state.claims.length, 1);
  assert.equal(state.events.length, 1);
});

test("wrong payout amount goes to reconciliation without completing accounting", async () => {
  const response = await sendCallback(
    "result",
    payload({ amount: 999 })
  );

  assert.equal(response.status, 200);
  assert.equal(state.withdrawal.status, "reconciliation_required");
  assert.equal(state.withdrawal.b2cInitiationState, "unknown");
  assert.equal(state.wallet.totalWithdrawalsCents, 0);
  assert.equal(state.ledger.status, "pending");
  assert.equal(state.claims.length, 0);
  assert.equal(state.events[0].processingStatus, "reconciliation_required");
});

test("a globally claimed receipt cannot complete a second withdrawal", async () => {
  state.claims.push({
    receipt: RECEIPT,
    purpose: "deposit",
    referenceId: "OTHER-TRANSACTION"
  });

  const response = await sendCallback("result", payload());

  assert.equal(response.status, 200);
  assert.equal(state.withdrawal.status, "reconciliation_required");
  assert.equal(state.wallet.totalWithdrawalsCents, 0);
  assert.equal(state.ledger.status, "pending");
  assert.equal(state.claims.length, 1);
  assert.equal(state.events[0].processingStatus, "reconciliation_required");
});

test("timeout callback requires reconciliation and never refunds automatically", async () => {
  const response = await sendCallback("timeout", payload());

  assert.equal(response.status, 200);
  assert.equal(state.withdrawal.status, "reconciliation_required");
  assert.equal(state.withdrawal.b2cInitiationState, "unknown");
  assert.equal(state.wallet.totalWithdrawalsCents, 0);
  assert.equal(state.ledger.status, "pending");
  assert.equal(state.claims.length, 0);
});

test("failed provider result requires reconciliation without refund", async () => {
  const response = await sendCallback(
    "result",
    payload({ resultCode: 1032 })
  );

  assert.equal(response.status, 200);
  assert.equal(state.withdrawal.status, "reconciliation_required");
  assert.equal(state.wallet.totalWithdrawalsCents, 0);
  assert.equal(state.ledger.status, "pending");
  assert.equal(state.claims.length, 0);
});

test("invalid callback token is rejected without storing an event", async () => {
  const response = await sendCallback("result", payload(), "wrong-token");

  assert.equal(response.status, 401);
  assert.equal(state.events.length, 0);
  assert.equal(state.wallet.totalWithdrawalsCents, 0);
});
