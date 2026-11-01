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
const Membership = require("../src/models/Membership");
const NotesTask = require("../src/models/NotesTask");
const NotesSubmission = require("../src/models/NotesSubmission");
const NotesPointsWallet = require("../src/models/NotesPointsWallet");
const NotesPointsTransaction = require("../src/models/NotesPointsTransaction");
const notesTasksRoutes = require("../src/routes/notesTasks");

const uri = process.env.PTW_TEST_MONGODB_URI;

const userIds = [];
const taskIds = [];

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

async function request(path, {
  userId,
  method = "GET",
  body
} = {}) {
  const headers = {};

  if (userId) headers.Cookie = cookieFor(userId);

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
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

async function createUser(role = "user") {
  const suffix = randomUUID().replace(/-/g, "");
  const userId = new mongoose.Types.ObjectId();

  userIds.push(userId);

  await User.create({
    _id: userId,
    firstName: "Notes",
    lastName: "GateTest",
    username: `ng_${suffix.slice(0, 20)}`,
    email: `notes-gate-${suffix}@example.test`,
    phone: `test-${suffix.slice(0, 12)}`,
    passwordHash: "integration-test-hash-not-a-real-password",
    role,
    status: "active",
    sessionVersion: 0
  });

  return userId;
}

async function grantMembership(userId, {
  services = ["note-taking"],
  status = "active",
  startsAt = new Date(Date.now() - 60_000),
  expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
} = {}) {
  return Membership.create({
    userId,
    planId: new mongoose.Types.ObjectId(),
    planKey: "notes-gate-test",
    priceCents: 100,
    currency: "USD",
    services,
    status,
    startsAt,
    expiresAt
  });
}

async function createTask(createdByAdminId, {
  status = "available",
  assignedUserId = null,
  assignmentExpiresAt = null
} = {}) {
  const task = await NotesTask.create({
    title: "Membership gate test task",
    description: "Integration test task.",
    expectedNotes: "Test notes",
    durationMinutes: 5,
    rewardCents: 100,
    taskCostCents: 5,
    status,
    assignedUserId,
    claimedAt: assignedUserId ? new Date() : null,
    assignmentExpiresAt,
    createdByAdminId,
    publishedAt: new Date()
  });

  taskIds.push(task._id);
  return task;
}

async function createPointsWallet(userId, balancePoints = 100) {
  return NotesPointsWallet.create({
    userId,
    balancePoints,
    totalPurchasedPoints: balancePoints,
    totalSpentPoints: 0
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
    Membership.init(),
    NotesTask.init(),
    NotesSubmission.init(),
    NotesPointsWallet.init(),
    NotesPointsTransaction.init()
  ]);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/notes/tasks", notesTasksRoutes);

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
      NotesSubmission.deleteMany({ userId: { $in: userIds } }),
      NotesPointsTransaction.deleteMany({ userId: { $in: userIds } }),
      NotesPointsWallet.deleteMany({ userId: { $in: userIds } }),
      NotesTask.deleteMany({
        $or: [
          { _id: { $in: taskIds } },
          { assignedUserId: { $in: userIds } }
        ]
      }),
      Membership.deleteMany({ userId: { $in: userIds } }),
      User.deleteMany({ _id: { $in: userIds } })
    ]);
  } finally {
    if (connected) await mongoose.disconnect();
  }
});

test("nonmember can browse available Notes tasks", async () => {
  const adminId = await createUser("admin");
  const userId = await createUser("user");
  const task = await createTask(adminId);

  const result = await request("/api/notes/tasks/available", { userId });

  assert.equal(result.status, 200);
  assert.equal(result.data.success, true);
  assert.ok(
    result.data.tasks.some(item => item.id === String(task._id)),
    "The available task should be visible to a nonmember."
  );
});

test("nonmember cannot claim a Notes task", async () => {
  const adminId = await createUser("admin");
  const userId = await createUser("user");
  const task = await createTask(adminId);

  const result = await request(
    `/api/notes/tasks/${task._id}/claim`,
    { userId, method: "POST" }
  );

  assert.equal(result.status, 403);
  assert.equal(result.data.code, "MEMBERSHIP_REQUIRED");

  const unchangedTask = await NotesTask.findById(task._id).lean();
  assert.equal(unchangedTask.status, "available");
  assert.equal(unchangedTask.assignedUserId, null);

  const wallet = await NotesPointsWallet.findOne({ userId }).lean();
  assert.equal(wallet, null);
});

test("nonmember cannot submit notes for an existing assignment", async () => {
  const adminId = await createUser("admin");
  const userId = await createUser("user");

  const task = await createTask(adminId, {
    status: "assigned",
    assignedUserId: userId,
    assignmentExpiresAt: new Date(Date.now() + 30 * 60 * 1000)
  });

  const result = await request(
    `/api/notes/tasks/${task._id}/submissions`,
    {
      userId,
      method: "POST",
      body: { notesText: "Attempted submission without membership." }
    }
  );

  assert.equal(result.status, 403);
  assert.equal(result.data.code, "MEMBERSHIP_REQUIRED");

  const unchangedTask = await NotesTask.findById(task._id).lean();
  assert.equal(unchangedTask.status, "assigned");

  const submission = await NotesSubmission.findOne({
    taskId: task._id,
    userId
  }).lean();

  assert.equal(submission, null);
});

test("transcription-only membership does not grant Notes access", async () => {
  const adminId = await createUser("admin");
  const userId = await createUser("user");

  await grantMembership(userId, {
    services: ["transcription"]
  });

  const task = await createTask(adminId);

  const result = await request(
    `/api/notes/tasks/${task._id}/claim`,
    { userId, method: "POST" }
  );

  assert.equal(result.status, 403);
  assert.equal(result.data.code, "MEMBERSHIP_REQUIRED");
});

test("expired Notes membership cannot claim tasks", async () => {
  const adminId = await createUser("admin");
  const userId = await createUser("user");

  await grantMembership(userId, {
    status: "active",
    startsAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    expiresAt: new Date(Date.now() - 60_000)
  });

  const task = await createTask(adminId);

  const result = await request(
    `/api/notes/tasks/${task._id}/claim`,
    { userId, method: "POST" }
  );

  assert.equal(result.status, 403);
  assert.equal(result.data.code, "MEMBERSHIP_REQUIRED");
});

test("expired Notes membership cannot submit a previously claimed task", async () => {
  const adminId = await createUser("admin");
  const userId = await createUser("user");

  await grantMembership(userId, {
    status: "active",
    startsAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    expiresAt: new Date(Date.now() - 60_000)
  });

  const task = await createTask(adminId, {
    status: "assigned",
    assignedUserId: userId,
    assignmentExpiresAt: new Date(Date.now() + 30 * 60 * 1000)
  });

  const result = await request(
    `/api/notes/tasks/${task._id}/submissions`,
    {
      userId,
      method: "POST",
      body: { notesText: "Submission after membership expiry." }
    }
  );

  assert.equal(result.status, 403);
  assert.equal(result.data.code, "MEMBERSHIP_REQUIRED");

  const unchangedTask = await NotesTask.findById(task._id).lean();
  assert.equal(unchangedTask.status, "assigned");
});

test("active Notes member can claim a task and spend Points", async () => {
  const adminId = await createUser("admin");
  const userId = await createUser("user");

  await grantMembership(userId);
  await createPointsWallet(userId, 100);

  const task = await createTask(adminId);

  const result = await request(
    `/api/notes/tasks/${task._id}/claim`,
    { userId, method: "POST" }
  );

  assert.equal(result.status, 200);
  assert.equal(result.data.success, true);
  assert.equal(result.data.assignment.status, "assigned");

  const wallet = await NotesPointsWallet.findOne({ userId }).lean();
  assert.equal(wallet.balancePoints, 95);
  assert.equal(wallet.totalSpentPoints, 5);

  const transaction = await NotesPointsTransaction.findOne({
    userId,
    type: "task_claim"
  }).lean();

  assert.ok(transaction);
  assert.equal(transaction.points, -5);
});

test("active Notes member can submit notes for an active assignment", async () => {
  const adminId = await createUser("admin");
  const userId = await createUser("user");

  await grantMembership(userId);

  const task = await createTask(adminId, {
    status: "assigned",
    assignedUserId: userId,
    assignmentExpiresAt: new Date(Date.now() + 30 * 60 * 1000)
  });

  const result = await request(
    `/api/notes/tasks/${task._id}/submissions`,
    {
      userId,
      method: "POST",
      body: { notesText: "These are valid integration test notes." }
    }
  );

  assert.equal(result.status, 201);
  assert.equal(result.data.success, true);
  assert.equal(result.data.submission.status, "submitted");

  const updatedTask = await NotesTask.findById(task._id).lean();
  assert.equal(updatedTask.status, "submitted");

  const submission = await NotesSubmission.findOne({
    taskId: task._id,
    userId
  }).lean();

  assert.ok(submission);
  assert.equal(
    submission.notesText,
    "These are valid integration test notes."
  );
});

test("admin can claim a Notes task without a Notes membership", async () => {
  const adminId = await createUser("admin");
  await createPointsWallet(adminId, 100);

  const task = await createTask(adminId);

  const result = await request(
    `/api/notes/tasks/${task._id}/claim`,
    { userId: adminId, method: "POST" }
  );

  assert.equal(result.status, 200);
  assert.equal(result.data.success, true);
});

test("founder can claim a Notes task without a Notes membership", async () => {
  const founderId = await createUser("founder");
  await createPointsWallet(founderId, 100);

  const task = await createTask(founderId);

  const result = await request(
    `/api/notes/tasks/${task._id}/claim`,
    { userId: founderId, method: "POST" }
  );

  assert.equal(result.status, 200);
  assert.equal(result.data.success, true);
});
