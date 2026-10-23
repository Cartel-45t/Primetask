"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const Module = require("node:module");

const USER_ID = "111111111111111111111111";
const PURCHASE_ID = "222222222222222222222222";
const PACKAGE_ID = "333333333333333333333333";
const IDEMPOTENCY_KEY = "minute-test-key-001";

let membershipActive;
let purchase;
let createCount;
let darajaBehavior;
let darajaCalls;
let server;
let baseUrl;
let router;

const testPackage = {
  _id: PACKAGE_ID,
  name: "Test Minutes",
  minutes: 60,
  priceCents: 500,
  priceKes: 650,
  isActive: true
};

const minutePackageMock = {
  findOne(query) {
    const matches =
      String(query._id) === PACKAGE_ID &&
      query.isActive === true &&
      testPackage.isActive;

    return {
      lean: async () => matches ? { ...testPackage } : null
    };
  }
};

function applyUpdate(update) {
  Object.assign(purchase, update.$set || {});
  for (const key of Object.keys(update.$unset || {})) {
    delete purchase[key];
  }
}

const minutePurchaseMock = {
  async findOne(query) {
    if (!purchase) return null;

    if (
      query.idempotencyKey != null &&
      String(query.userId) === USER_ID &&
      query.idempotencyKey === purchase.idempotencyKey
    ) {
      return { ...purchase };
    }

    if (
      query._id != null &&
      String(query._id) === String(purchase._id) &&
      (query.userId == null || String(query.userId) === USER_ID)
    ) {
      return { ...purchase };
    }

    if (
      query.paymentStatus?.$in?.includes(purchase.paymentStatus) &&
      String(query.userId) === USER_ID
    ) {
      return { ...purchase };
    }

    return null;
  },

  async create(data) {
    createCount += 1;

    if (purchase) {
      const error = new Error("Duplicate purchase");
      error.code = 11000;
      throw error;
    }

    purchase = {
      ...data,
      _id: PURCHASE_ID,
      checkoutRequestId: null,
      merchantRequestId: null,
      mpesaReceipt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z")
    };

    return { ...purchase };
  },

  async findOneAndUpdate(filter, update) {
    if (
      !purchase ||
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
      purchase &&
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

const darajaMock = {
  async initiateStkPush(args) {
    darajaCalls.push({ ...args });

    if (darajaBehavior instanceof Error) {
      throw darajaBehavior;
    }

    if (typeof darajaBehavior === "function") {
      return darajaBehavior(args);
    }

    return { ...darajaBehavior };
  }
};

const membershipMock = {
  findOne(query) {
    const eligible =
      membershipActive &&
      query.status === "active" &&
      query.services === "transcription";

    return {
      lean: async () => eligible ? { services: ["transcription"] } : null
    };
  }
};

const originalLoad = Module._load;

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

    if (request === "../models/Membership") {
      return membershipMock;
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

function resetState() {
  membershipActive = true;
  purchase = null;
  createCount = 0;

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

  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });

  server = null;
});

async function purchaseMinutes(overrides = {}) {
  const response = await fetch(`${baseUrl}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      packageId: PACKAGE_ID,
      phoneNumber: "0712345678",
      idempotencyKey: IDEMPOTENCY_KEY,
      ...overrides
    })
  });

  return {
    status: response.status,
    body: await response.json()
  };
}

test("one submission creates purchase and requests STK", async () => {
  const result = await purchaseMinutes();

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.paymentInitiationEnabled, true);
  assert.equal(result.body.purchase.paymentStatus, "pending");
  assert.equal(
    result.body.purchase.checkoutRequestId,
    "CHECKOUT-TEST-1"
  );

  assert.equal(createCount, 1);
  assert.equal(darajaCalls.length, 1);
  assert.deepEqual(darajaCalls[0], {
    phoneNumber: "254712345678",
    amountKes: 650,
    accountReference: purchase.purchaseReference,
    transactionDesc: "Minutes 60"
  });

  assert.equal(purchase.mpesaReceipt, null);
  assert.equal(purchase.availableMinutes, undefined);
  assert.equal(purchase.priceCents, 500);
  assert.equal(purchase.currency, "USD");
});

test("disabled Daraja records purchase but confirms no prompt was requested", async () => {
  darajaBehavior = {
    mode: "disabled",
    accepted: false,
    message: "Daraja initiation is disabled."
  };

  const result = await purchaseMinutes();

  assert.equal(result.status, 503);
  assert.equal(result.body.paymentInitiationEnabled, false);
  assert.equal(purchase.paymentStatus, "failed");
  assert.equal(purchase.failureCode, "DARAJA_INITIATION_DISABLED");
  assert.equal(purchase.checkoutRequestId, null);
  assert.equal(createCount, 1);
  assert.equal(darajaCalls.length, 1);
});

test("uncertain provider result locks purchase and same-key retry cannot send another prompt", async () => {
  darajaBehavior = new Error("Provider timeout");

  const first = await purchaseMinutes();

  assert.equal(first.status, 503);
  assert.equal(first.body.paymentStatus, "verification_required");
  assert.equal(purchase.paymentStatus, "verification_required");
  assert.equal(
    purchase.failureCode,
    "STK_INITIATION_IN_PROGRESS"
  );
  assert.equal(darajaCalls.length, 1);

  const retry = await purchaseMinutes();

  assert.equal(retry.status, 200);
  assert.equal(retry.body.reused, true);
  assert.equal(createCount, 1);
  assert.equal(darajaCalls.length, 1);
});

test("different idempotency key cannot create another purchase while first is unresolved", async () => {
  darajaBehavior = new Error("Provider timeout");

  const first = await purchaseMinutes();
  assert.equal(first.status, 503);
  assert.equal(purchase.paymentStatus, "verification_required");

  const retry = await purchaseMinutes({
    idempotencyKey: "minute-test-key-002"
  });

  assert.equal(retry.status, 409);
  assert.equal(retry.body.success, false);
  assert.equal(retry.body.purchase.id, PURCHASE_ID);
  assert.match(retry.body.message, /awaiting payment verification/i);
  assert.equal(createCount, 1);
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

  const result = await purchaseMinutes();

  assert.equal(result.status, 502);
  assert.equal(result.body.paymentStatus, "verification_required");
  assert.equal(purchase.paymentStatus, "verification_required");
  assert.equal(
    purchase.failureCode,
    "STK_RESULT_REQUIRES_RECONCILIATION"
  );
  assert.equal(purchase.checkoutRequestId, "CHECKOUT-REJECTED");
  assert.equal(purchase.mpesaReceipt, null);
  assert.equal(darajaCalls.length, 1);
});

test("invalid package is rejected before creating a purchase or contacting Daraja", async () => {
  const result = await purchaseMinutes({ packageId: "invalid-id" });

  assert.equal(result.status, 400);
  assert.equal(createCount, 0);
  assert.equal(darajaCalls.length, 0);
});

test("invalid Kenyan phone is rejected before creating a purchase", async () => {
  const result = await purchaseMinutes({ phoneNumber: "12345" });

  assert.equal(result.status, 400);
  assert.equal(createCount, 0);
  assert.equal(darajaCalls.length, 0);
});

test("invalid idempotency key is rejected", async () => {
  const result = await purchaseMinutes({ idempotencyKey: "short" });

  assert.equal(result.status, 400);
  assert.equal(createCount, 0);
  assert.equal(darajaCalls.length, 0);
});

test("repeating the same idempotency key never creates another purchase or STK request", async () => {
  const first = await purchaseMinutes();
  const second = await purchaseMinutes();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.reused, true);
  assert.equal(createCount, 1);
  assert.equal(darajaCalls.length, 1);
});

test("inactive or missing package is rejected without STK", async () => {
  testPackage.isActive = false;

  try {
    const result = await purchaseMinutes();

    assert.equal(result.status, 404);
    assert.equal(createCount, 0);
    assert.equal(darajaCalls.length, 0);
  } finally {
    testPackage.isActive = true;
  }
});


test("membership without transcription cannot create a purchase or request STK", async () => {
  membershipActive = false;

  const result = await purchaseMinutes();

  assert.equal(result.status, 403);
  assert.equal(result.body.success, false);
  assert.equal(result.body.code, "MEMBERSHIP_REQUIRED");
  assert.equal(createCount, 0);
  assert.equal(darajaCalls.length, 0);
});

