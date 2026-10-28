"use strict";

require("dotenv").config();

const { randomUUID } = require("node:crypto");
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const User = require("../src/models/User");
const Wallet = require("../src/models/Wallet");
const WalletTransaction = require("../src/models/WalletTransaction");
const NotesWallet = require("../src/models/NotesWallet");
const NotesTransaction = require("../src/models/NotesTransaction");
const notesWalletRoutes = require("../src/routes/notesWallet");

const uri = process.env.PTW_TEST_MONGODB_URI;
const userIds = [];

let connected = false;
let server;
let baseUrl;

function cookieFor(userId) {
  const token = jwt.sign(
    { sub: String(userId), role: "user" },
    process.env.JWT_SECRET,
    {
      expiresIn: "5m",
      issuer: "primetask-workspace",
      audience: "primetask-workspace-users"
    }
  );

  return `ptw_session=${token}`;
}

async function request(path, {
  userId,
  method = "GET",
  body,
  idempotencyKey
} = {}) {
  const headers = {};

  if (userId) headers.Cookie = cookieFor(userId);

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  return {
    status: response.status,
    data: await response.json()
  };
}

async function createFixture(balanceCents = 1000) {
  const suffix = randomUUID().replace(/-/g, "");
  const userId = new mongoose.Types.ObjectId();

  userIds.push(userId);

  await User.create({
    _id: userId,
    firstName: "Notes",
    lastName: "WalletTest",
    username: `notes_${suffix.slice(0, 20)}`,
    email: `notes-${suffix}@example.test`,
    phone: `test-${suffix.slice(0, 12)}`,
    passwordHash: "integration-test-hash-not-a-real-password",
    role: "user",
    status: "active",
    referredBy: null
  });

  await Wallet.create({
    userId,
    currency: "USD",
    availableBalanceCents: balanceCents,
    pendingEarningsCents: 0,
    totalEarningsCents: 0,
    totalWithdrawalsCents: 0
  });

  return { userId };
}

function newKey(prefix = "notes-test") {
  return `${prefix}-${randomUUID()}`;
}

before(async () => {
  if (!uri) {
    throw new Error("PTW_TEST_MONGODB_URI is not configured.");
  }

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error("A valid test JWT_SECRET must be configured.");
  }

  const databaseName = decodeURIComponent(
    new URL(uri).pathname.replace(/^\/+/, "")
  );

  assert.match(
    databaseName.toLowerCase(),
    /test/,
    "Refusing to run against a database whose name does not contain 'test'."
  );

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  connected = true;

  await Promise.all([
    User.init(),
    Wallet.init(),
    WalletTransaction.init(),
    NotesWallet.init(),
    NotesTransaction.init()
  ]);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/notes/wallet", notesWalletRoutes);

  server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.once("error", reject);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }

    if (!connected || userIds.length === 0) return;

    await Promise.all([
      NotesTransaction.deleteMany({ userId: { $in: userIds } }),
      WalletTransaction.deleteMany({ userId: { $in: userIds } }),
      NotesWallet.deleteMany({ userId: { $in: userIds } }),
      Wallet.deleteMany({ userId: { $in: userIds } }),
      User.deleteMany({ _id: { $in: userIds } })
    ]);
  } finally {
    if (connected) await mongoose.disconnect();
  }
});

test("unauthenticated Notes wallet requests are rejected", async () => {
  const result = await request("/api/notes/wallet");

  assert.equal(result.status, 401);
  assert.equal(result.data.success, false);
});

test("wallet summary returns USD balances and initializes Notes wallet", async () => {
  const { userId } = await createFixture(1500);

  const result = await request("/api/notes/wallet", { userId });

  assert.equal(result.status, 200);
  assert.equal(result.data.success, true);
  assert.equal(result.data.currency, "USD");
  assert.equal(result.data.wallet.availableBalanceCents, 0);
  assert.equal(result.data.wallet.availableBalance, 0);
  assert.equal(result.data.mainWallet.availableBalanceCents, 1500);
  assert.equal(result.data.mainWallet.availableBalance, 15);

  const notesWallet = await NotesWallet.findOne({ userId }).lean();
  assert.ok(notesWallet);
  assert.equal(notesWallet.availableBalanceCents, 0);
});

test("invalid amounts and missing idempotency keys are rejected", async () => {
  const { userId } = await createFixture(2000);

  const invalidAmount = await request("/api/notes/wallet/credits", {
    userId,
    method: "POST",
    body: { amountCents: 99 },
    idempotencyKey: newKey()
  });

  assert.equal(invalidAmount.status, 400);
  assert.equal(invalidAmount.data.success, false);

  const missingKey = await request("/api/notes/wallet/credits", {
    userId,
    method: "POST",
    body: { amountCents: 500 }
  });

  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.data.success, false);

  const mainWallet = await Wallet.findOne({ userId }).lean();
  assert.equal(mainWallet.availableBalanceCents, 2000);

  assert.equal(await WalletTransaction.countDocuments({ userId }), 0);
  assert.equal(await NotesTransaction.countDocuments({ userId }), 0);
});

test("successful transfer debits main wallet and credits Notes wallet once", async () => {
  const { userId } = await createFixture(1000);
  const key = newKey("notes-success");

  const result = await request("/api/notes/wallet/credits", {
    userId,
    method: "POST",
    body: { amountCents: 275 },
    idempotencyKey: key
  });

  assert.equal(result.status, 201);
  assert.equal(result.data.success, true);
  assert.equal(result.data.duplicate, false);
  assert.equal(result.data.currency, "USD");
  assert.equal(result.data.transferredCents, 275);
  assert.equal(result.data.transferredAmount, 2.75);
  assert.equal(result.data.notesBalanceCents, 275);
  assert.equal(result.data.notesBalance, 2.75);

  const [mainWallet, notesWallet] = await Promise.all([
    Wallet.findOne({ userId }).lean(),
    NotesWallet.findOne({ userId }).lean()
  ]);

  assert.equal(mainWallet.availableBalanceCents, 725);
  assert.equal(notesWallet.availableBalanceCents, 275);
  assert.equal(notesWallet.totalPurchasedCents, 275);

  const [mainLedger, notesLedger] = await Promise.all([
    WalletTransaction.find({ userId }).lean(),
    NotesTransaction.find({ userId }).lean()
  ]);

  assert.equal(mainLedger.length, 1);
  assert.equal(mainLedger[0].type, "transfer_out");
  assert.equal(mainLedger[0].amountCents, 275);
  assert.equal(mainLedger[0].currency, "USD");
  assert.equal(mainLedger[0].status, "completed");
  assert.ok(mainLedger[0].reference.length <= 120);

  assert.equal(notesLedger.length, 1);
  assert.equal(notesLedger[0].type, "credit_purchase");
  assert.equal(notesLedger[0].amountCents, 275);
  assert.equal(notesLedger[0].reference, mainLedger[0].reference);
});

test("repeating an idempotency key does not transfer money twice", async () => {
  const { userId } = await createFixture(1000);
  const key = newKey("notes-repeat");
  const body = { amountCents: 300 };

  const first = await request("/api/notes/wallet/credits", {
    userId,
    method: "POST",
    body,
    idempotencyKey: key
  });

  assert.equal(first.status, 201);

  const second = await request("/api/notes/wallet/credits", {
    userId,
    method: "POST",
    body,
    idempotencyKey: key
  });

  assert.equal(second.status, 200);
  assert.equal(second.data.success, true);
  assert.equal(second.data.duplicate, true);
  assert.equal(second.data.transferredCents, 300);

  const [mainWallet, notesWallet] = await Promise.all([
    Wallet.findOne({ userId }).lean(),
    NotesWallet.findOne({ userId }).lean()
  ]);

  assert.equal(mainWallet.availableBalanceCents, 700);
  assert.equal(notesWallet.availableBalanceCents, 300);
  assert.equal(notesWallet.totalPurchasedCents, 300);
  assert.equal(await WalletTransaction.countDocuments({ userId }), 1);
  assert.equal(await NotesTransaction.countDocuments({ userId }), 1);
});

test("insufficient main wallet funds leave both wallets and ledgers unchanged", async () => {
  const { userId } = await createFixture(150);

  const result = await request("/api/notes/wallet/credits", {
    userId,
    method: "POST",
    body: { amountCents: 200 },
    idempotencyKey: newKey("notes-insufficient")
  });

  assert.equal(result.status, 400);
  assert.equal(result.data.success, false);
  assert.equal(result.data.code, "INSUFFICIENT_FUNDS");

  const mainWallet = await Wallet.findOne({ userId }).lean();
  assert.equal(mainWallet.availableBalanceCents, 150);

  assert.equal(await WalletTransaction.countDocuments({ userId }), 0);
  assert.equal(await NotesTransaction.countDocuments({ userId }), 0);

  const notesWallet = await NotesWallet.findOne({ userId }).lean();
  assert.equal(notesWallet, null);
});

test("transaction history returns the Notes credit purchase", async () => {
  const { userId } = await createFixture(1000);

  const transfer = await request("/api/notes/wallet/credits", {
    userId,
    method: "POST",
    body: { amountCents: 425 },
    idempotencyKey: newKey("notes-history")
  });

  assert.equal(transfer.status, 201);

  const history = await request("/api/notes/wallet/transactions?limit=10", {
    userId
  });

  assert.equal(history.status, 200);
  assert.equal(history.data.success, true);
  assert.equal(history.data.currency, "USD");
  assert.equal(history.data.transactions.length, 1);
  assert.equal(history.data.transactions[0].type, "credit_purchase");
  assert.equal(history.data.transactions[0].amountCents, 425);
  assert.equal(history.data.transactions[0].amount, 4.25);
});
