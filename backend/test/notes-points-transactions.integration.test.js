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
const NotesPointsTransaction = require("../src/models/NotesPointsTransaction");
const notesPointsTransactionsRoutes = require("../src/routes/notesPointsTransactions");

const uri = process.env.PTW_TEST_MONGODB_URI;
const userIds = [];

let connected = false;
let server;
let baseUrl;

function cookieFor(userId) {
  const token = jwt.sign(
    { sub: String(userId), role: "user", sv: 0 },
    process.env.JWT_SECRET,
    {
      expiresIn: "10m",
      issuer: "primetask-workspace",
      audience: "primetask-workspace-users"
    }
  );

  return `ptw_session=${token}`;
}

async function request(path, { userId } = {}) {
  const headers = {};

  if (userId) {
    headers.Cookie = cookieFor(userId);
  }

  const response = await fetch(`${baseUrl}${path}`, { headers });

  return {
    status: response.status,
    data: await response.json()
  };
}

async function createUser() {
  const suffix = randomUUID().replace(/-/g, "");
  const userId = new mongoose.Types.ObjectId();

  userIds.push(userId);

  await User.create({
    _id: userId,
    firstName: "Points",
    lastName: "HistoryTest",
    username: `ph_${suffix.slice(0, 20)}`,
    email: `points-history-${suffix}@example.test`,
    phone: `test-${suffix.slice(0, 12)}`,
    passwordHash: "integration-test-hash-not-a-real-password",
    role: "user",
    status: "active",
    sessionVersion: 0
  });

  return userId;
}

async function createTransaction(userId, {
  type = "purchase_credit",
  points = 20,
  description = "Integration test transaction",
  reference = `points-test-${randomUUID()}`,
  createdAt = new Date()
} = {}) {
  return NotesPointsTransaction.create({
    userId,
    walletId: new mongoose.Types.ObjectId(),
    type,
    points,
    description,
    reference,
    createdAt
  });
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
    NotesPointsTransaction.init()
  ]);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    "/api/notes/points-transactions",
    notesPointsTransactionsRoutes
  );

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

    await Promise.all([
      NotesPointsTransaction.deleteMany({
        userId: { $in: userIds }
      }),
      User.deleteMany({
        _id: { $in: userIds }
      })
    ]);
  } finally {
    if (connected) {
      await mongoose.disconnect();
    }
  }
});

test("unauthenticated Points transaction history requests are rejected", async () => {
  const result = await request("/api/notes/points-transactions");

  assert.equal(result.status, 401);
  assert.equal(result.data.success, false);
});

test("Points transaction history returns only the authenticated user's records in newest-first order", async () => {
  const userId = await createUser();
  const anotherUserId = await createUser();

  const oldest = await createTransaction(userId, {
    points: 10,
    description: "Oldest transaction",
    createdAt: new Date("2026-01-01T10:00:00.000Z")
  });

  const newest = await createTransaction(userId, {
    type: "task_claim",
    points: -15,
    description: "Newest transaction",
    createdAt: new Date("2026-01-03T10:00:00.000Z")
  });

  await createTransaction(anotherUserId, {
    points: 99,
    description: "Private transaction belonging to another user"
  });

  const result = await request(
    "/api/notes/points-transactions",
    { userId }
  );

  assert.equal(result.status, 200);
  assert.equal(result.data.success, true);
  assert.equal(result.data.unit, "Notes Points");
  assert.equal(result.data.transactions.length, 2);

  assert.equal(
    result.data.transactions[0].id,
    String(newest._id)
  );
  assert.equal(
    result.data.transactions[0].description,
    "Newest transaction"
  );
  assert.equal(result.data.transactions[0].type, "task_claim");
  assert.equal(result.data.transactions[0].points, -15);

  assert.equal(
    result.data.transactions[1].id,
    String(oldest._id)
  );

  assert.ok(
    result.data.transactions.every(
      item => item.description !==
        "Private transaction belonging to another user"
    )
  );

  for (const item of result.data.transactions) {
    assert.ok(item.id);
    assert.ok(item.type);
    assert.ok(Number.isSafeInteger(item.points));
    assert.ok(item.description);
    assert.ok(item.reference);
    assert.ok(item.createdAt);
  }
});

test("Points transaction history enforces the maximum 50-record limit", async () => {
  const userId = await createUser();
  const baseTime = Date.parse("2026-02-01T00:00:00.000Z");

  for (let index = 0; index < 55; index += 1) {
    await createTransaction(userId, {
      points: index + 1,
      description: `Limit test transaction ${index + 1}`,
      reference: `points-limit-${randomUUID()}`,
      createdAt: new Date(baseTime + index * 1000)
    });
  }

  const result = await request(
    "/api/notes/points-transactions?limit=500",
    { userId }
  );

  assert.equal(result.status, 200);
  assert.equal(result.data.success, true);
  assert.equal(result.data.transactions.length, 50);

  assert.equal(
    result.data.transactions[0].description,
    "Limit test transaction 55"
  );

  assert.equal(
    result.data.transactions[49].description,
    "Limit test transaction 6"
  );
});
