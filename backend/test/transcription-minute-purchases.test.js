"use strict";


const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const Module = require("node:module");

const USER_ID = "111111111111111111111111";
const PURCHASE_ID = "222222222222222222222222";

let purchase;
let darajaBehavior;
let darajaCalls;
let server;
let baseUrl;

const minutePackageMock = {};
const minutePurchaseMock = {
  async findOne(query) {
    if (
      String(query._id) !== String(purchase._id) ||
      String(query.userId) !== USER_ID
    ) {
      return null;
    }
    return { ...purchase };
  },

  async findOneAndUpdate(filter, update) {
    if (
      String(filter._id) !== String(purchase._id) ||
      (filter.userId != null && String(filter.userId) !== USER_ID) ||
      purchase.paymentStatus !== filter.paymentStatus ||
      (filter.checkoutRequestId === null &&
        purchase.checkoutRequestId != null) ||
      (filter.merchantRequestId === null &&
        purchase.merchantRequestId != null) ||
      (filter.failureCode &&
        purchase.failureCode !== filter.failureCode)
    ) {
      return null;
    }

    applyUpdate(update);
    return { ...purchase };
  },

  async updateOne(filter, update) {
    if (
      String(filter._id) === String(purchase._id) &&
      purchase.paymentStatus === filter.paymentStatus &&
      (!filter.failureCode ||
        purchase.failureCode === filter.failureCode)
    ) {
      applyUpdate(update);
      return { modifiedCount: 1 };
    }
    return { modifiedCount: 0 };
  }
};

function applyUpdate(update) {
  Object.assign(purchase, update.$set || {});
  for (const key of Object.keys(update.$unset || {})) {
    delete purchase[key];
  }
}

const darajaMock = {
  async initiateStkPush(args) {
    darajaCalls.push(args);

    if (darajaBehavior instanceof Error) {
      throw darajaBehavior;
    }

    if (typeof darajaBehavior === "function") {
      return darajaBehavior(args);
    }

    return { ...darajaBehavior };
  }
};

const originalLoad = Module._load;
let router;

function loadRouteWithMocks() {

  Module._load = function (request, parent, isMain) {
    if (request === "../middleware/requireAuth") {
      return (req, res, next) => {
        req.user = { _id: USER_ID };
        next();
      };
    }

    if (request === "../models/TranscriptionMinutePackage") {
      return minutePackageMock;
    }

    if (request === "../models/TranscriptionMinutePurchase") {
      return minutePurchaseMock;
    }

    if (request === "../services/transcriptionDarajaService") {
      return darajaMock;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const routePath = require.resolve(
      "../src/routes/transcriptionMinutePurchases"
    );
    delete require.cache[routePath];
    router = require(routePath);

  } finally {
    Module._load = originalLoad;
  }
}

function resetPurchase() {
  purchase = {
    _id: PURCHASE_ID,
    userId: USER_ID,
    purchaseReference: "PTW-TM-TEST-001",
    packageId: "333333333333333333333333",
    packageName: "Test Minutes",
    minutes: 60,
    priceCents: 500,
    currency: "USD",
    expectedAmountKes: 650,
    phoneNumber: "254712345678",
    paymentStatus: "pending",
    checkoutRequestId: null,
    merchantRequestId: null,
    mpesaReceipt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z")
  };

  darajaBehavior = {
    mode: "live",
    accepted: true,
    merchantRequestId: "MERCHANT-TEST-1",
    checkoutRequestId: "CHECKOUT-TEST-1",
    customerMessage: "Test prompt accepted."
  };

  darajaCalls = [];
}

beforeEach(async () => {

  resetPurchase();

  if (!router) {
    loadRouteWithMocks();
  }

  const app = express();
  app.use(express.json());
  app.use("/", router);
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (!server) return;

  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });

  server = null;
});

async function initiate(id = PURCHASE_ID) {


  const response = await fetch(
    `${baseUrl}/${id}/initiate`,
    { method: "POST" }
  );

  return {
    status: response.status,
    body: await response.json()
  };
}

test("successful STK initiation records IDs but does not credit minutes", async () => {
  const result = await initiate();

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.purchase.paymentStatus, "pending");
  assert.equal(result.body.purchase.checkoutRequestId, "CHECKOUT-TEST-1");
  assert.equal(result.body.purchase.currency, "USD");
  assert.equal(purchase.checkoutRequestId, "CHECKOUT-TEST-1");
  assert.equal(purchase.mpesaReceipt, null);
  assert.equal(purchase.availableMinutes, undefined);
  assert.equal(darajaCalls.length, 1);
  assert.deepEqual(darajaCalls[0], {
    phoneNumber: "254712345678",
    amountKes: 650,
    accountReference: "PTW-TM-TEST-001",
    transactionDesc: "Minutes 60"
  });
});

test("disabled Daraja restores pending and reports no prompt requested", async () => {
  darajaBehavior = {
    mode: "disabled",
    accepted: false,
    message: "Disabled"
  };

  const result = await initiate();

  assert.equal(result.status, 503);
  assert.equal(result.body.paymentInitiationEnabled, false);
  assert.equal(purchase.paymentStatus, "pending");
  assert.equal(purchase.failureCode, undefined);
  assert.equal(purchase.checkoutRequestId, null);
  assert.equal(darajaCalls.length, 1);
});

test("uncertain provider error locks purchase for reconciliation", async () => {
  darajaBehavior = new Error("Provider timeout");

  const result = await initiate();

  assert.equal(result.status, 503);
  assert.equal(result.body.paymentStatus, "verification_required");
  assert.equal(purchase.paymentStatus, "verification_required");
  assert.equal(purchase.failureCode, "STK_INITIATION_IN_PROGRESS");
  assert.equal(darajaCalls.length, 1);

  const retry = await initiate();

  assert.equal(retry.status, 409);
  assert.equal(darajaCalls.length, 1);
});

test("rejected or incomplete STK response locks purchase for reconciliation", async () => {
  darajaBehavior = {
    mode: "live",
    accepted: false,
    merchantRequestId: "MERCHANT-REJECTED",
    checkoutRequestId: "CHECKOUT-REJECTED",
    responseDescription: "Rejected test response"
  };

  const result = await initiate();

  assert.equal(result.status, 502);
  assert.equal(result.body.paymentStatus, "verification_required");
  assert.equal(purchase.paymentStatus, "verification_required");
  assert.equal(
    purchase.failureCode,
    "STK_RESULT_REQUIRES_RECONCILIATION"
  );
  assert.equal(purchase.checkoutRequestId, "CHECKOUT-REJECTED");
  assert.equal(purchase.mpesaReceipt, null);

  const retry = await initiate();

  assert.equal(retry.status, 409);
  assert.equal(darajaCalls.length, 1);
});

test("purchase with an existing checkout ID cannot initiate another prompt", async () => {
  purchase.checkoutRequestId = "CHECKOUT-ALREADY-EXISTS";

  const result = await initiate();

  assert.equal(result.status, 409);
  assert.equal(darajaCalls.length, 0);
});

test("invalid purchase ID is rejected without contacting Daraja", async () => {
  const result = await initiate("not-an-object-id");

  assert.equal(result.status, 400);
  assert.equal(darajaCalls.length, 0);
});
