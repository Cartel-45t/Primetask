"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const Module = require("node:module");

const USER_ID = "111111111111111111111111";
const ADMIN_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const PURCHASE_ID = "222222222222222222222222";
const CHECKOUT_ID = "CHECKOUT-TEST-1";

let purchase;
let wallet;
let claims;
let transactions;
let audits;
let failAudit;
let failTransaction;
let server;
let baseUrl;
let router;

const originalLoad = Module._load;

const purchaseModel = {
  find(query) {
    return {
      select() { return this; },
      populate() { return this; },
      sort() { return this; },
      limit() { return Promise.resolve([]); }
    };
  },

  findById(id) {
    return {
      session() {
        return String(id) === PURCHASE_ID ? purchase : null;
      }
    };
  },

  async updateOne(filter, update) {
    if (
      String(filter._id) !== PURCHASE_ID ||
      !["pending", "verification_required"].includes(
        purchase.paymentStatus
      ) ||
      purchase.checkoutRequestId !== filter.checkoutRequestId ||
      purchase.expectedAmountKes !== filter.expectedAmountKes
    ) {
      return { modifiedCount: 0 };
    }

    Object.assign(purchase, update.$set || {});
    return { modifiedCount: 1 };
  }
};

const walletModel = {
  async findOneAndUpdate(filter, update) {
    if (String(filter.userId) !== USER_ID) {
      throw new Error("Unexpected wallet user");
    }

    if (!wallet) {
      wallet = {
        _id: "bbbbbbbbbbbbbbbbbbbbbbbb",
        userId: USER_ID,
        availableMinutes: 0,
        totalPurchasedMinutes: 0
      };
    }

    wallet.availableMinutes += update.$inc.availableMinutes;
    wallet.totalPurchasedMinutes += update.$inc.totalPurchasedMinutes;

    return { ...wallet };
  }
};

const receiptModel = {
  async create(records) {
    for (const record of records) {
      if (claims.some(item => item.receipt === record.receipt)) {
        const error = new Error("Duplicate receipt");
        error.code = 11000;
        throw error;
      }
    }

    claims.push(...records.map(record => ({ ...record })));
    return records;
  }
};

const transactionModel = {
  async create(records) {
    if (failTransaction) {
      throw new Error("Simulated ledger failure");
    }

    transactions.push(...records.map(record => ({ ...record })));
    return records;
  }
};

const auditModel = {
  async create(records) {
    if (failAudit) {
      throw new Error("Simulated audit failure");
    }

    audits.push(...records.map(record => ({ ...record })));
    return records;
  }
};

function snapshot() {
  return structuredClone({
    purchase,
    wallet,
    claims,
    transactions,
    audits
  });
}

function restore(state) {
  purchase = state.purchase;
  wallet = state.wallet;
  claims = state.claims;
  transactions = state.transactions;
  audits = state.audits;
}

const mongooseMock = {
  isValidObjectId(value) {
    return typeof value === "string" &&
      /^[a-f0-9]{24}$/i.test(value);
  },

  async startSession() {
    return {
      async withTransaction(callback) {
        const state = snapshot();

        try {
          await callback();
        } catch (error) {
          restore(state);
          throw error;
        }
      },

      async endSession() {}
    };
  }
};

function loadRoute() {
  Module._load = function (request, parent, isMain) {
    if (request === "mongoose") return mongooseMock;

    if (request === "../middleware/requireAuth") {
      return (req, res, next) => {
        req.user = {
          _id: ADMIN_ID,
          role: "admin"
        };
        next();
      };
    }

    if (request === "../models/TranscriptionMinutePurchase") {
      return purchaseModel;
    }

    if (request === "../models/TranscriptionMinuteWallet") {
      return walletModel;
    }

    if (request === "../models/TranscriptionMinuteTransaction") {
      return transactionModel;
    }

    if (request === "../models/MpesaReceiptClaim") {
      return receiptModel;
    }

    if (request === "../models/AdminAuditLog") {
      return auditModel;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const routePath = require.resolve(
      "../src/routes/adminTranscriptionMinuteReconciliation"
    );

    delete require.cache[routePath];
    router = require(routePath);
  } finally {
    Module._load = originalLoad;
  }
}

function resetState() {
  purchase = {
    _id: PURCHASE_ID,
    userId: USER_ID,
    purchaseReference: "PTW-TM-TEST-001",
    packageName: "Test Minutes",
    minutes: 60,
    priceCents: 500,
    currency: "USD",
    expectedAmountKes: 650,
    phoneNumber: "254712345678",
    paymentStatus: "pending",
    checkoutRequestId: CHECKOUT_ID,
    merchantRequestId: "MERCHANT-TEST-1",
    mpesaReceipt: null
  };

  wallet = null;
  claims = [];
  transactions = [];
  audits = [];
  failAudit = false;
  failTransaction = false;
}

beforeEach(async () => {
  resetState();

  if (!router) loadRoute();

  const app = express();
  app.use(express.json());
  app.use("/", router);

  server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

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

async function verify(overrides = {}) {
  const response = await fetch(
    `${baseUrl}/${PURCHASE_ID}/verify`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        checkoutRequestId: CHECKOUT_ID,
        amountKes: 650,
        mpesaReceipt: "ABC123XYZ",
        evidenceSource: "safaricom_portal",
        evidenceReference: "PORTAL-RECORD-001",
        ...overrides
      })
    }
  );

  return {
    status: response.status,
    body: await response.json()
  };
}

test("successful reconciliation credits minutes and audits atomically", async () => {
  const result = await verify();

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.data.minutesCredited, 60);
  assert.equal(purchase.paymentStatus, "verified");
  assert.equal(purchase.mpesaReceipt, "ABC123XYZ");
  assert.equal(wallet.availableMinutes, 60);
  assert.equal(wallet.totalPurchasedMinutes, 60);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].purpose, "transcription_minute_purchase");
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].type, "purchase_credit");
  assert.equal(String(transactions[0].purchaseId), PURCHASE_ID);
  assert.equal(audits.length, 1);
  assert.equal(
    audits[0].action,
    "transcription_minute_purchase_verified"
  );
});

test("checkout mismatch is rejected without changing financial state", async () => {
  const result = await verify({
    checkoutRequestId: "WRONG-CHECKOUT"
  });

  assert.equal(result.status, 409);
  assert.equal(purchase.paymentStatus, "pending");
  assert.equal(wallet, null);
  assert.equal(claims.length, 0);
  assert.equal(transactions.length, 0);
  assert.equal(audits.length, 0);
});

test("amount mismatch is rejected without crediting minutes", async () => {
  const result = await verify({ amountKes: 651 });

  assert.equal(result.status, 409);
  assert.equal(purchase.paymentStatus, "pending");
  assert.equal(wallet, null);
  assert.equal(claims.length, 0);
  assert.equal(transactions.length, 0);
  assert.equal(audits.length, 0);
});

test("a globally reused receipt is rejected", async () => {
  claims.push({ receipt: "ABC123XYZ" });

  const result = await verify();

  assert.equal(result.status, 409);
  assert.equal(purchase.paymentStatus, "pending");
  assert.equal(wallet, null);
  assert.equal(transactions.length, 0);
  assert.equal(audits.length, 0);
  assert.equal(claims.length, 1);
});

test("repeated verification cannot credit minutes twice", async () => {
  const first = await verify();

  assert.equal(first.status, 200);

  const second = await verify();

  assert.equal(second.status, 409);
  assert.equal(wallet.availableMinutes, 60);
  assert.equal(wallet.totalPurchasedMinutes, 60);
  assert.equal(claims.length, 1);
  assert.equal(transactions.length, 1);
  assert.equal(audits.length, 1);
});

test("ledger failure rolls back receipt claim and wallet credit", async () => {
  failTransaction = true;

  const result = await verify();

  assert.equal(result.status, 503);
  assert.equal(purchase.paymentStatus, "pending");
  assert.equal(wallet, null);
  assert.equal(claims.length, 0);
  assert.equal(transactions.length, 0);
  assert.equal(audits.length, 0);
});

test("audit failure rolls back verification and minute credit", async () => {
  failAudit = true;

  const result = await verify();

  assert.equal(result.status, 503);
  assert.equal(purchase.paymentStatus, "pending");
  assert.equal(wallet, null);
  assert.equal(claims.length, 0);
  assert.equal(transactions.length, 0);
  assert.equal(audits.length, 0);
});
