"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const Module = require("node:module");
const mongoose = require("mongoose");

const SID = "111111111111111111111111";
const TID = "222222222222222222222222";
const UID = "333333333333333333333333";
const AID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const WID = "bbbbbbbbbbbbbbbbbbbbbbbb";

const originalLoad = Module._load;
const originalStartSession = mongoose.startSession;

let state, router, server, baseUrl, failLedger, duplicateLedger, listingItems;
const notificationCalls = [];

function resetState() {
  state = {
    submission: {
      _id: SID,
      taskId: TID,
      userId: UID,
      taskTitle: "Lecture notes",
      notesText: "Test notes",
      status: "submitted",
      submittedAt: new Date(),
      reviewedAt: null,
      reviewedByAdminId: null,
      reviewNotes: "",
      createdAt: new Date(),
      async save() {}
    },
    task: {
      _id: TID,
      title: "Lecture notes",
      rewardCents: 300,
      durationMinutes: 12,
      status: "submitted",
      assignedUserId: UID,
      completedAt: null
    },
    wallet: null,
    transactions: []
  };

  state.submission.save = async function () {};
  failLedger = false;
  duplicateLedger = false;
  listingItems = [];
  notificationCalls.length = 0;
}

function snapshot() {
  return {
    submission: {
      ...state.submission,
      save: undefined
    },
    task: { ...state.task },
    wallet: state.wallet ? { ...state.wallet } : null,
    transactions: state.transactions.map(x => ({ ...x }))
  };
}

const submissionModel = {
  find(filter) {
    let requestedStatus = filter.status;
    const query = {
      sort() { return this; },
      limit() { return this; },
      populate() { return this; },
      async lean() {
        return listingItems.filter(item => item.status === requestedStatus);
      }
    };
    return query;
  },

  findOne(filter) {
    return {
      session: async () =>
        String(filter._id) === SID &&
        state.submission.status === filter.status
          ? state.submission
          : null
    };
  }
};

const taskModel = {
  findOne(filter) {
    return {
      session: async () =>
        String(filter._id) === TID &&
        state.task.status === filter.status &&
        String(state.task.assignedUserId) === String(filter.assignedUserId)
          ? state.task
          : null
    };
  },

  async findOneAndUpdate(filter, update) {
    if (
      String(filter._id) !== TID ||
      state.task.status !== filter.status ||
      String(state.task.assignedUserId) !== String(filter.assignedUserId)
    ) return null;

    Object.assign(state.task, update.$set);
    return { ...state.task };
  }
};

const walletModel = {
  async updateOne(filter) {
    if (!state.wallet && String(filter.userId) === UID) {
      state.wallet = {
        _id: WID,
        userId: UID,
        availableBalanceCents: 0,
        totalEarningsCents: 0
      };
    }
    return { acknowledged: true };
  },

  async findOneAndUpdate(filter, update) {
    if (!state.wallet || String(filter.userId) !== UID) return null;

    for (const [key, amount] of Object.entries(update.$inc)) {
      state.wallet[key] += amount;
    }
    return { ...state.wallet };
  }
};

const transactionModel = {
  async create(records) {
    if (failLedger) throw new Error("Simulated ledger failure");

    if (
      duplicateLedger ||
      state.transactions.some(x => x.reference === records[0].reference)
    ) {
      const error = new Error("Duplicate ledger reference");
      error.code = 11000;
      throw error;
    }

    state.transactions.push(...records.map(x => ({ ...x })));
    return records;
  }
};

function loadRoute() {
  const mocks = {
    "../models/NotesSubmission": submissionModel,
    "../models/NotesTask": taskModel,
    "../models/NotesWallet": walletModel,
    "../models/NotesTransaction": transactionModel,
    "../models/User": {
      findById(id) {
        assert.equal(String(id), UID);
        return {
          select() {
            return {
              lean: async () => ({
                firstName: "Test Member",
                email: "member@example.test"
              })
            };
          }
        };
      }
    },
    "../services/achievementNotificationEmailService": {
      async sendNotesApprovalEmail(payload) {
        notificationCalls.push(payload);
        return { id: "mock-email-id" };
      }
    }
  };

  Module._load = function (request, parent, isMain) {
    if (parent?.filename?.endsWith("/routes/adminNotesSubmissions.js")) {
      if (request === "mongoose") return mongoose;
      if (mocks[request]) return mocks[request];

      if (request === "../middleware/requireAuth") {
        return (req, res, next) => {
          const role = req.headers["x-test-role"];
          if (!role) {
            return res.status(401).json({ success: false });
          }
          req.user = { _id: AID, role };
          next();
        };
      }
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const path = require.resolve("../src/routes/adminNotesSubmissions");
    delete require.cache[path];
    router = require(path);
  } finally {
    Module._load = originalLoad;
  }
}

async function request(role, body, id = SID) {
  const headers = {};
  if (role) headers["x-test-role"] = role;
  if (body) headers["content-type"] = "application/json";

  const response = await fetch(
    `${baseUrl}/${id}/review`,
    {
      method: "PATCH",
      headers,
      body: body ? JSON.stringify(body) : undefined
    }
  );

  return { response, body: await response.json() };
}

async function listRequest(role, query = "") {
  const headers = {};
  if (role) headers["x-test-role"] = role;

  const response = await fetch(
    `${baseUrl}/${query}`,
    { method: "GET", headers }
  );

  return { response, body: await response.json() };
}

beforeEach(async () => {
  resetState();
  if (!router) loadRoute();

  mongoose.startSession = async () => ({
    async withTransaction(callback) {
      const saved = snapshot();

      try {
        await callback();
      } catch (error) {
        Object.assign(state.submission, saved.submission);
        state.task = saved.task;
        state.wallet = saved.wallet;
        state.transactions = saved.transactions;
        throw error;
      }
    },
    async endSession() {}
  });

  const app = express();
  app.use(express.json());
  app.use("/api/admin/notes/submissions", router);

  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/notes/submissions`;
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

test("rejects requests without authentication", async () => {
  const { response } = await request(null, { action: "approve" });
  assert.equal(response.status, 401);
});

test("blocks ordinary members from reviewing submissions", async () => {
  const { response } = await request("user", { action: "approve" });
  assert.equal(response.status, 403);
});

test("admin listing returns structured submission data and legacy defaults", async () => {
  listingItems = [
    {
      _id: SID,
      taskId: {
        _id: TID,
        title: "Lecture notes",
        status: "submitted"
      },
      userId: {
        _id: UID,
        username: "testmember",
        firstName: "Test",
        lastName: "Member",
        email: "member@example.test"
      },
      taskTitle: "Lecture notes",
      notesText: "Generated Cornell notes",
      format: "cornell",
      sections: {
        cues: "What is photosynthesis?",
        notes: "Plants convert light energy into chemical energy.",
        summary: "Photosynthesis stores light energy."
      },
      status: "submitted",
      submittedAt: new Date(),
      createdAt: new Date()
    },
    {
      _id: "444444444444444444444444",
      taskId: TID,
      userId: UID,
      taskTitle: "Older notes",
      notesText: "Legacy plain notes",
      status: "submitted",
      submittedAt: new Date(),
      createdAt: new Date()
    }
  ];

  const { response, body } = await listRequest("admin", "?status=submitted");

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.submissions.length, 2);

  const structured = body.submissions[0];
  assert.equal(structured.format, "cornell");
  assert.deepEqual(structured.sections, {
    cues: "What is photosynthesis?",
    notes: "Plants convert light energy into chemical energy.",
    summary: "Photosynthesis stores light energy."
  });
  assert.equal(structured.member.username, "testmember");
  assert.equal(structured.taskTitle, "Lecture notes");

  const legacy = body.submissions[1];
  assert.equal(legacy.format, "plain");
  assert.deepEqual(legacy.sections, {});
  assert.equal(legacy.notesText, "Legacy plain notes");
});

test("admin listing validates status filters and blocks ordinary members", async () => {
  const invalid = await listRequest("admin", "?status=pending");
  const forbidden = await listRequest("user", "?status=submitted");
  const unauthenticated = await listRequest(null, "?status=submitted");

  assert.equal(invalid.response.status, 400);
  assert.equal(forbidden.response.status, 403);
  assert.equal(unauthenticated.response.status, 401);
});

test("admin approval credits the correct USD cents and creates one ledger entry", async () => {
  const { response, body } = await request("admin", {
    action: "approve",
    reviewNotes: "Clear and complete."
  });

  assert.equal(response.status, 200);
  assert.equal(body.review.rewardCents, 300);
  assert.equal(body.review.walletBalanceCents, 300);
  assert.equal(state.wallet.availableBalanceCents, 300);
  assert.equal(state.wallet.totalEarningsCents, 300);
  assert.equal(state.task.status, "completed");
  assert.equal(state.submission.status, "approved");
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].type, "task_earning");
  assert.equal(state.transactions[0].amountCents, 300);
  assert.equal(state.transactions[0].reference, `NOTES-EARNING-${SID}`);

  assert.equal(notificationCalls.length, 1);
  assert.deepEqual(notificationCalls[0], {
    email: "member@example.test",
    firstName: "Test Member",
    amountCents: 300
  });
});

test("founder can approve submissions", async () => {
  const { response } = await request("founder", { action: "approve" });
  assert.equal(response.status, 200);
  assert.equal(notificationCalls.length, 1);
});

test("prevents a second approval from crediting earnings again", async () => {
  const first = await request("admin", { action: "approve" });
  const second = await request("admin", { action: "approve" });

  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 409);
  assert.equal(state.wallet.availableBalanceCents, 300);
  assert.equal(state.transactions.length, 1);
});

test("rejection requires review notes and does not credit earnings", async () => {
  const missingNotes = await request("admin", { action: "reject" });
  assert.equal(missingNotes.response.status, 400);

  const rejected = await request("admin", {
    action: "reject",
    reviewNotes: "The requested outline was not followed."
  });

  assert.equal(rejected.response.status, 200);
  assert.equal(state.submission.status, "rejected");
  assert.equal(state.task.status, "archived");
  assert.equal(state.wallet, null);
  assert.equal(state.transactions.length, 0);
  assert.equal(notificationCalls.length, 0);
});

test("validates submission IDs and review actions", async () => {
  const badId = await request("admin", { action: "approve" }, "invalid-id");
  const badAction = await request("admin", { action: "unknown" });

  assert.equal(badId.response.status, 400);
  assert.equal(badAction.response.status, 400);
});

test("rolls back changes when earnings ledger creation fails", async () => {
  failLedger = true;

  const { response } = await request("admin", { action: "approve" });

  assert.equal(response.status, 500);
  assert.equal(state.wallet, null);
  assert.equal(state.task.status, "submitted");
  assert.equal(state.submission.status, "submitted");
  assert.equal(state.transactions.length, 0);
  assert.equal(notificationCalls.length, 0);
});

test("duplicate earning reference returns conflict and rolls back", async () => {
  duplicateLedger = true;

  const { response, body } = await request("admin", { action: "approve" });

  assert.equal(response.status, 409);
  assert.equal(body.code, "DUPLICATE_EARNING");
  assert.equal(state.wallet, null);
  assert.equal(state.task.status, "submitted");
  assert.equal(state.submission.status, "submitted");
});
