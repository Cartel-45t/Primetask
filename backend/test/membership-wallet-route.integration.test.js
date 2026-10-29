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
const MembershipPlan = require("../src/models/MembershipPlan");
const MembershipPurchase = require("../src/models/MembershipPurchase");
const Membership = require("../src/models/Membership");
const Commission = require("../src/models/Commission");
const membershipRoutes = require("../src/routes/membership");

const uri = process.env.PTW_TEST_MONGODB_URI;
const userIds = [];
const planIds = [];

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
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

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

async function createFixture({ balanceCents, priceCents = 2500 }) {
  const suffix = randomUUID().replace(/-/g, "");
  const userId = new mongoose.Types.ObjectId();
  const planId = new mongoose.Types.ObjectId();

  userIds.push(userId);
  planIds.push(planId);

  await User.create({
    _id: userId,
    firstName: "HTTP",
    lastName: "WalletTest",
    username: `route_${suffix.slice(0, 20)}`,
    email: `route-${suffix}@example.test`,
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

  const plan = await MembershipPlan.create({
    _id: planId,
    key: `route-test-${suffix.slice(0, 16)}`,
    name: "Wallet HTTP Route Test",
    description: "Automated integration test",
    priceCents,
    currency: "USD",
    durationDays: 30,
    services: ["data-entry"],
    commissionAmountsCents: [0, 0, 0, 0],
    commissionEnabled: false,
    active: true,
    mpesaAmountKes: null
  });

  return { userId, plan };
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
    MembershipPlan.init(),
    MembershipPurchase.init(),
    Membership.init(),
    Commission.init()
  ]);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/membership", membershipRoutes);

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

    if (!connected) return;

    const purchases = await MembershipPurchase.find({
      purchaserUserId: { $in: userIds }
    }).select("_id").lean();

    const purchaseIds = purchases.map(item => item._id);

    const memberships = await Membership.find({
      $or: [
        { purchaseId: { $in: purchaseIds } },
        { userId: { $in: userIds } }
      ]
    }).select("_id").lean();

    const membershipIds = memberships.map(item => item._id);

    if (membershipIds.length) {
      await Commission.deleteMany({
        membershipId: { $in: membershipIds }
      });
    }

    await WalletTransaction.deleteMany({
      $or: [
        { membershipPurchaseId: { $in: purchaseIds } },
        { userId: { $in: userIds } }
      ]
    });

    await Membership.deleteMany({
      $or: [
        { purchaseId: { $in: purchaseIds } },
        { userId: { $in: userIds } }
      ]
    });

    await MembershipPurchase.deleteMany({
      purchaserUserId: { $in: userIds }
    });

    await Wallet.deleteMany({ userId: { $in: userIds } });
    await MembershipPlan.deleteMany({ _id: { $in: planIds } });
    await User.deleteMany({ _id: { $in: userIds } });
  } finally {
    if (connected) await mongoose.disconnect();
  }
});

test("unauthenticated wallet purchase is rejected", async () => {
  const result = await request("/api/membership/purchases/wallet", {
    method: "POST",
    body: { planId: new mongoose.Types.ObjectId().toString() },
    idempotencyKey: `unauth-${randomUUID()}`
  });

  assert.equal(result.status, 401);
  assert.equal(result.data.success, false);
});

test("active plans include a wallet-only plan without an M-Pesa amount", async () => {
  const { userId, plan } = await createFixture({ balanceCents: 10000 });

  const result = await request("/api/membership/plans", { userId });

  assert.equal(result.status, 200);
  assert.equal(result.data.success, true);
  assert.equal(result.data.currency, "USD");

  const listed = result.data.plans.find(item => item.id === String(plan._id));
  assert.ok(listed, "Expected the active wallet-only plan in the response.");
  assert.equal(listed.price, 25);
  assert.equal(listed.currency, "USD");
  assert.equal(listed.mpesaAmountKes, null);
});

test("HTTP wallet purchase debits exact USD cents and activates membership once", async () => {
  const { userId, plan } = await createFixture({
    balanceCents: 10000,
    priceCents: 2500
  });

  const key = `route-success-${randomUUID()}`;
  const path = "/api/membership/purchases/wallet";
  const body = { planId: String(plan._id) };

  const first = await request(path, {
    userId,
    method: "POST",
    body,
    idempotencyKey: key
  });

  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.success, true);
  assert.equal(first.data.purchase.currency, "USD");
  assert.equal(first.data.purchase.amount, 25);
  assert.equal(first.data.purchase.paymentMethod, "wallet");
  assert.ok(first.data.membership.id);

  const second = await request(path, {
    userId,
    method: "POST",
    body,
    idempotencyKey: key
  });

  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(second.data.success, true);
  assert.equal(second.data.reused, true);

  const wallet = await Wallet.findOne({ userId }).lean();
  assert.equal(wallet.availableBalanceCents, 7500);
  assert.equal(wallet.currency, "USD");

  const purchases = await MembershipPurchase.find({
    purchaserUserId: userId,
    idempotencyKey: key
  }).lean();

  assert.equal(purchases.length, 1);
  assert.equal(purchases[0].paymentStatus, "verified");

  const memberships = await Membership.countDocuments({
    purchaseId: purchases[0]._id
  });
  assert.equal(memberships, 1);

  const ledger = await WalletTransaction.find({
    membershipPurchaseId: purchases[0]._id
  }).lean();

  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].type, "membership_purchase");
  assert.equal(ledger[0].amountCents, 2500);
  assert.equal(ledger[0].currency, "USD");
  assert.equal(ledger[0].status, "completed");
});

test("insufficient balance returns 402 without debit or membership", async () => {
  const { userId, plan } = await createFixture({
    balanceCents: 1000,
    priceCents: 2500
  });

  const result = await request("/api/membership/purchases/wallet", {
    userId,
    method: "POST",
    body: { planId: String(plan._id) },
    idempotencyKey: `route-poor-${randomUUID()}`
  });

  assert.equal(result.status, 402, JSON.stringify(result.data));
  assert.equal(result.data.success, false);
  assert.equal(result.data.code, "INSUFFICIENT_WALLET_BALANCE");
  assert.equal(result.data.amount, 25);
  assert.equal(result.data.currency, "USD");

  const wallet = await Wallet.findOne({ userId }).lean();
  assert.equal(wallet.availableBalanceCents, 1000);

  const purchase = await MembershipPurchase.findOne({
    purchaserUserId: userId
  }).lean();

  assert.ok(purchase);
  assert.equal(purchase.paymentStatus, "failed");
  assert.equal(purchase.failureCode, "INSUFFICIENT_WALLET_BALANCE");

  assert.equal(
    await Membership.countDocuments({ purchaseId: purchase._id }),
    0
  );

  assert.equal(
    await WalletTransaction.countDocuments({
      membershipPurchaseId: purchase._id
    }),
    0
  );
});

test("reusing an idempotency key for a different plan returns 409", async () => {
  const { userId, plan: firstPlan } = await createFixture({
    balanceCents: 20000
  });
  const { plan: secondPlan } = await createFixture({
    balanceCents: 20000
  });

  const key = `route-conflict-${randomUUID()}`;
  const path = "/api/membership/purchases/wallet";

  const first = await request(path, {
    userId,
    method: "POST",
    body: { planId: String(firstPlan._id) },
    idempotencyKey: key
  });

  assert.equal(first.status, 201, JSON.stringify(first.data));

  const conflict = await request(path, {
    userId,
    method: "POST",
    body: { planId: String(secondPlan._id) },
    idempotencyKey: key
  });

  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, "IDEMPOTENCY_CONFLICT");

  const wallet = await Wallet.findOne({ userId }).lean();
  assert.equal(wallet.availableBalanceCents, 17500);

  assert.equal(
    await MembershipPurchase.countDocuments({
      purchaserUserId: userId,
      idempotencyKey: key
    }),
    1
  );
});
