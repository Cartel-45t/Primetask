"use strict";

const { test, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const Module = require("node:module");
const mongoose = require("mongoose");

const USER_ID = "111111111111111111111111";
const ADMIN_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";

const originalLoad = Module._load;
const originalStartSession = mongoose.startSession;

let wallet;
let transactions;
let failLedger;
let forceConflict;
let server;
let baseUrl;
let router;

const userModel = {
  findById(id) {
    return {
      select() {
        return {
          session: async () =>
            String(id) === USER_ID ? { _id: USER_ID } : null
        };
      }
    };
  }
};

const minuteWalletModel = {
  findOne() {
    return {
      session: async () => wallet
    };
  },

  async create(records) {
    const record = {
      _id: WALLET_ID,
      userId: records[0].userId,
      availableMinutes: 0,
      reservedMinutes: 0,
      totalPurchasedMinutes: 0,
      totalSpentMinutes: 0,
      totalRefundedMinutes: 0
    };

    wallet = record;
    return [record];
  },

  async findOneAndUpdate(filter, update) {
    if (forceConflict) return null;

    if (
      !wallet ||
      String(wallet._id) !== String(filter._id) ||
      String(wallet.userId) !== String(filter.userId) ||
      wallet.availableMinutes !== filter.availableMinutes
    ) {
      return null;
    }

    Object.assign(wallet, update.$set);
    return { ...wallet };
  }
};

const minuteTransactionModel = {
  async create(records) {
    if (failLedger) {
      throw new Error("Simulated ledger failure");
    }

    transactions.push(...records.map(record => ({ ...record })));
    return records;
  }
};

function snapshot() {
  return {
    wallet: wallet ? { ...wallet } : null,
    transactions: transactions.map(record => ({ ...record }))
  };
}

function restore(state) {
  wallet = state.wallet;
  transactions = state.transactions;
}

function loadRoute() {
  const modelMocks = {
    "../models/User": userModel,
    "../models/TranscriptionMinuteWallet": minuteWalletModel,
    "../models/TranscriptionMinuteTransaction": minuteTransactionModel
  };

  Module._load = function (request, parent, isMain) {
    if (parent?.filename?.endsWith("/routes/adminUsers.js")) {
      if (modelMocks[request]) return modelMocks[request];

      if (request.startsWith("../models/")) return {};
      if (request === "../middleware/requireAuth") {
        return (req, res, next) => {
          const role = req.headers["x-test-role"];

          if (!role) {
            return res.status(401).json({
              success: false,
              message: "Authentication required."
            });
          }

          req.user = {
            _id: ADMIN_ID,
            username: "test_admin",
            role
          };

          next();
        };
      }
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const routePath = require.resolve("../src/routes/adminUsers");
    delete require.cache[routePath];
    router = require(routePath);
  } finally {
    Module._load = originalLoad;
  }
}

async function request(body, options = {}) {
  const headers = {};

  if (options.role) headers["x-test-role"] = options.role;
  if (body !== undefined) headers["content-type"] = "application/json";

  return fetch(`${baseUrl}/api/admin/users/${USER_ID}/transcription-minutes`, {
    method: options.method || "PUT",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(async response => ({
    response,
    body: await response.json()
  }));
}

beforeEach(async () => {
  wallet = {
    _id: WALLET_ID,
    userId: USER_ID,
    availableMinutes: 60,
    reservedMinutes: 0,
    totalPurchasedMinutes: 60,
    totalSpentMinutes: 0,
    totalRefundedMinutes: 0
  };

  transactions = [];
  failLedger = false;
  forceConflict = false;

  if (!router) loadRoute();

  mongoose.startSession = async () => ({
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
  });

  const app = express();
  app.use(express.json());
  app.use("/api/admin/users", router);

  server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  mongoose.startSession = originalStartSession;

  if (server) {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }

  server = null;
});

after(() => {
  mongoose.startSession = originalStartSession;
});

test("admin can increase the available minute balance and ledger the change", async () => {
  const { response, body } = await request(
    { availableMinutes: 150 },
    { role: "admin" }
  );

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.previousAvailableMinutes, 60);
  assert.equal(body.data.availableMinutes, 150);
  assert.equal(body.data.adjustmentMinutes, 90);
  assert.equal(wallet.availableMinutes, 150);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].type, "admin_adjustment");
  assert.equal(transactions[0].minutes, 90);
  assert.equal(transactions[0].createdByAdminId, ADMIN_ID);
});

test("founder can decrease the available minute balance", async () => {
  const { response, body } = await request(
    { availableMinutes: 25 },
    { role: "founder" }
  );

  assert.equal(response.status, 200);
  assert.equal(body.data.availableMinutes, 25);
  assert.equal(body.data.adjustmentMinutes, 35);
  assert.equal(transactions.length, 1);
  assert.match(transactions[0].description, /decreased/i);
});

test("unchanged balance does not create a ledger entry", async () => {
  const { response, body } = await request(
    { availableMinutes: 60 },
    { role: "admin" }
  );

  assert.equal(response.status, 200);
  assert.equal(body.data.changed, false);
  assert.equal(body.data.adjustmentMinutes, 0);
  assert.equal(transactions.length, 0);
});

test("rejects invalid balances without changing the wallet", async () => {
  for (const availableMinutes of [-1, 1.5, "120", null, 1000000001]) {
    const { response } = await request(
      { availableMinutes },
      { role: "admin" }
    );

    assert.equal(response.status, 400, `Rejected ${String(availableMinutes)}`);
    assert.equal(wallet.availableMinutes, 60);
    assert.equal(transactions.length, 0);
  }
});

test("rejects requests without authentication", async () => {
  const { response } = await request({ availableMinutes: 90 });

  assert.equal(response.status, 401);
  assert.equal(wallet.availableMinutes, 60);
  assert.equal(transactions.length, 0);
});

test("ordinary users cannot adjust minute balances", async () => {
  const { response } = await request(
    { availableMinutes: 90 },
    { role: "user" }
  );

  assert.equal(response.status, 403);
  assert.equal(wallet.availableMinutes, 60);
  assert.equal(transactions.length, 0);
});

test("ledger failure rolls the wallet balance back", async () => {
  failLedger = true;

  const { response, body } = await request(
    { availableMinutes: 200 },
    { role: "admin" }
  );

  assert.equal(response.status, 500);
  assert.equal(body.success, false);
  assert.equal(wallet.availableMinutes, 60);
  assert.equal(transactions.length, 0);
});

test("concurrent balance change returns conflict without a ledger entry", async () => {
  forceConflict = true;

  const { response, body } = await request(
    { availableMinutes: 200 },
    { role: "admin" }
  );

  assert.equal(response.status, 409);
  assert.equal(body.success, false);
  assert.equal(wallet.availableMinutes, 60);
  assert.equal(transactions.length, 0);
});
