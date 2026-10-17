"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const Module = require("node:module");

const PURCHASE_ID = "222222222222222222222222";
const CHECKOUT_ID = "ws_CO_TestCallback123";

let purchase;
let events;
let server;
let baseUrl;
let router;

const originalLoad = Module._load;

const depositModel = {
  async findOne() {
    return null;
  }
};

const purchaseModel = {
  async findOne(query) {
    if (query.checkoutRequestId !== CHECKOUT_ID || !purchase) {
      return null;
    }

    return { ...purchase };
  },

  async updateOne(filter, update) {
    if (
      String(filter._id) !== PURCHASE_ID ||
      purchase.paymentStatus !== filter.paymentStatus
    ) {
      return { modifiedCount: 0 };
    }

    Object.assign(purchase, update.$set || {});
    return { modifiedCount: 1 };
  }
};

const eventModel = {
  async create(record) {
    if (events.some(item => item.eventKey === record.eventKey)) {
      const error = new Error("Duplicate event");
      error.code = 11000;
      throw error;
    }

    events.push({ ...record });
    return [record];
  },

  async findOne(query) {
    return events.find(item => item.eventKey === query.eventKey) || null;
  },

  async updateOne(filter, update) {
    const event = events.find(
      item => item.eventKey === filter.eventKey
    );

    if (event) {
      Object.assign(event, update.$set || {});
      return { modifiedCount: 1 };
    }

    return { modifiedCount: 0 };
  }
};

function loadRouteWithMocks() {
  Module._load = function (request, parent, isMain) {
    if (request === "../models/Deposit") return depositModel;
    if (request === "../models/TranscriptionMinutePurchase") {
      return purchaseModel;
    }
    if (request === "../models/DarajaCallbackEvent") return eventModel;

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const routePath = require.resolve("../src/routes/darajaCallbacks");
    delete require.cache[routePath];
    router = require(routePath);
  } finally {
    Module._load = originalLoad;
  }
}

function resetState(status = "pending") {
  purchase = {
    _id: PURCHASE_ID,
    checkoutRequestId: CHECKOUT_ID,
    paymentStatus: status,
    minutes: 60,
    expectedAmountKes: 650,
    mpesaReceipt: null
  };

  events = [];
}

function callbackPayload(resultCode = 0) {
  const stkCallback = {
    MerchantRequestID: "merchant-test-1",
    CheckoutRequestID: CHECKOUT_ID,
    ResultCode: resultCode,
    ResultDesc: resultCode === 0 ? "Success" : "Cancelled"
  };

  if (resultCode === 0) {
    stkCallback.CallbackMetadata = {
      Item: [
        { Name: "Amount", Value: 650 },
        { Name: "MpesaReceiptNumber", Value: "TEST123456" },
        { Name: "PhoneNumber", Value: 254712345678 },
        { Name: "TransactionDate", Value: 20261017123456 }
      ]
    };
  }

  return { Body: { stkCallback } };
}

async function sendCallback(payload) {
  return fetch(`${baseUrl}/stk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

beforeEach(async () => {
  resetState();

  if (!router) loadRouteWithMocks();

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

  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });

  server = null;
});

test("successful callback flags purchase for reconciliation without crediting minutes", async () => {
  const response = await sendCallback(callbackPayload(0));

  assert.equal(response.status, 200);
  assert.equal(purchase.paymentStatus, "verification_required");
  assert.equal(purchase.mpesaReceipt, null);
  assert.equal(events.length, 1);
  assert.equal(events[0].processingStatus, "reconciliation_required");
  assert.equal(events[0].callbackAmountKes, 650);
  assert.equal(events[0].callbackReceipt, "TEST123456");
});

test("failed callback never verifies purchase or credits minutes", async () => {
  const response = await sendCallback(callbackPayload(1032));

  assert.equal(response.status, 200);
  assert.equal(purchase.paymentStatus, "verification_required");
  assert.equal(purchase.mpesaReceipt, null);
  assert.equal(events.length, 1);
  assert.equal(events[0].resultCode, 1032);
  assert.equal(events[0].callbackAmountKes, null);
});

test("duplicate callback is idempotent and does not duplicate stored events", async () => {
  const payload = callbackPayload(0);

  const first = await sendCallback(payload);
  const second = await sendCallback(payload);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(events.length, 1);
  assert.equal(purchase.paymentStatus, "verification_required");
  assert.equal(purchase.mpesaReceipt, null);
});

test("unknown checkout is stored for reconciliation without changing a purchase", async () => {
  const payload = callbackPayload(0);
  payload.Body.stkCallback.CheckoutRequestID = "ws_CO_Unknown123";

  const response = await sendCallback(payload);

  assert.equal(response.status, 200);
  assert.equal(events.length, 1);
  assert.equal(events[0].processingStatus, "reconciliation_required");
  assert.equal(purchase.paymentStatus, "pending");
  assert.equal(purchase.mpesaReceipt, null);
});

test("callback does not downgrade an already verified purchase", async () => {
  purchase.paymentStatus = "verified";

  const response = await sendCallback(callbackPayload(0));

  assert.equal(response.status, 200);
  assert.equal(purchase.paymentStatus, "verified");
  assert.equal(purchase.mpesaReceipt, null);
  assert.equal(events.length, 1);
});
