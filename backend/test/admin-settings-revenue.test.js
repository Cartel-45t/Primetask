"use strict";

const { test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET =
  process.env.PTW_TEST_JWT_SECRET ||
  "ptw-v3-route-test-secret-only";

const User = require("../src/models/User");
const PlatformSetting = require("../src/models/PlatformSetting");
const AdminAuditLog = require("../src/models/AdminAuditLog");
const MembershipPurchase = require("../src/models/MembershipPurchase");
const Commission = require("../src/models/Commission");

const authRoutes = require("../src/routes/auth");
const settingsRoutes = require("../src/routes/adminSettings");
const revenueRoutes = require("../src/routes/adminRevenue");

const originals = {
  findById: User.findById,
  findOne: PlatformSetting.findOne,
  findOneAndUpdate: PlatformSetting.findOneAndUpdate,
  auditCreate: AdminAuditLog.create,
  purchaseAggregate: MembershipPurchase.aggregate,
  commissionAggregate: Commission.aggregate
};

const adminId = "507f1f77bcf86cd799439011";
let server;
let baseUrl;
let settingState;
let savedSettings;
let auditEntries;
let registrationSetting;
let salesRows;
let commissionRows;

function makeSettingsDocument() {
  return {
    key: "platform",
    registrationEnabled: settingState.registrationEnabled,
    maintenanceMode: settingState.maintenanceMode,
    exchangeRateKesPerUsd: settingState.exchangeRateKesPerUsd ?? null,
    updatedAt: settingState.updatedAt,
    updatedBy: settingState.updatedBy || null,
    async save() {
      settingState = {
        registrationEnabled: this.registrationEnabled,
        maintenanceMode: this.maintenanceMode,
        exchangeRateKesPerUsd: this.exchangeRateKesPerUsd,
        updatedAt: this.updatedAt,
        updatedBy: this.updatedBy
      };
      savedSettings++;
      return this;
    }
  };
}

function cookieFor(role) {
  const token = jwt.sign(
    { sub: adminId, role },
    process.env.JWT_SECRET,
    {
      expiresIn: "5m",
      issuer: "primetask-workspace",
      audience: "primetask-workspace-users"
    }
  );

  return `ptw_session=${token}`;
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };

  if (options.role) headers.Cookie = cookieFor(options.role);
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(baseUrl + path, {
    ...options,
    headers,
    body: options.body === undefined
      ? undefined
      : JSON.stringify(options.body)
  });

  return { response, body: await response.json() };
}

before(async () => {
  const app = express();
  app.use(express.json({ limit: "20kb" }));
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use("/api/admin/settings", settingsRoutes);
  app.use("/api/admin/revenue", revenueRoutes);

  server = app.listen(0, "127.0.0.1");

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  settingState = {
    registrationEnabled: true,
    maintenanceMode: false,
    exchangeRateKesPerUsd: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z")
  };
  savedSettings = 0;
  auditEntries = [];
  registrationSetting = null;
  salesRows = [{ _id: null, totalCents: 12550, purchases: 2 }];
  commissionRows = [
    { _id: "pending", totalCents: 1000, count: 2 },
    { _id: "paid", totalCents: 450, count: 1 },
    { _id: "reversed", totalCents: 100, count: 1 }
  ];

  User.findById = () => ({
    select: async () => ({
      _id: adminId,
      role: "admin",
      status: "active"
    })
  });

  PlatformSetting.findOneAndUpdate = async () => makeSettingsDocument();

  PlatformSetting.findOne = () => ({
    lean: async () => registrationSetting
  });

  AdminAuditLog.create = async entry => {
    auditEntries.push(entry);
    return entry;
  };

  MembershipPurchase.aggregate = async () => salesRows;
  Commission.aggregate = async () => commissionRows;
});

afterEach(() => {
  User.findById = originals.findById;
  PlatformSetting.findOne = originals.findOne;
  PlatformSetting.findOneAndUpdate = originals.findOneAndUpdate;
  AdminAuditLog.create = originals.auditCreate;
  MembershipPurchase.aggregate = originals.purchaseAggregate;
  Commission.aggregate = originals.commissionAggregate;
});

after(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
});

test("settings endpoint rejects requests without a session", async () => {
  const { response, body } = await request("/api/admin/settings");

  assert.equal(response.status, 401);
  assert.equal(body.success, false);
});

test("ordinary users cannot access platform settings", async () => {
  User.findById = () => ({
    select: async () => ({
      _id: adminId,
      role: "user",
      status: "active"
    })
  });

  const { response } = await request("/api/admin/settings", {
    role: "user"
  });

  assert.equal(response.status, 403);
});

test("settings endpoint returns platform defaults", async () => {
  const { response, body } = await request("/api/admin/settings", {
    role: "admin"
  });

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.registrationEnabled, true);
  assert.equal(body.data.maintenanceMode, false);
  assert.equal(body.data.exchangeRateKesPerUsd, null);
});

test("settings update saves changes and records an audit entry", async () => {
  const { response, body } = await request("/api/admin/settings", {
    method: "PUT",
    role: "admin",
    body: { registrationEnabled: false }
  });

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.registrationEnabled, false);
  assert.equal(settingState.registrationEnabled, false);
  assert.equal(savedSettings, 1);
  assert.equal(auditEntries.length, 1);
  assert.equal(auditEntries[0].action, "platform_settings_updated");
});

test("settings update rejects non-boolean and unknown fields", async () => {
  const invalidValues = [
    { registrationEnabled: "false" },
    { maintenanceMode: 1 },
    { unexpectedSetting: true },
    {}
  ];

  for (const body of invalidValues) {
    const { response } = await request("/api/admin/settings", {
      method: "PUT",
      role: "admin",
      body
    });

    assert.equal(response.status, 400);
  }

  assert.equal(savedSettings, 0);
  assert.equal(auditEntries.length, 0);
});

test("exchange rate can be saved and is included in the audit log", async () => {
  const { response, body } = await request("/api/admin/settings", {
    method: "PUT",
    role: "admin",
    body: { exchangeRateKesPerUsd: 130.25 }
  });

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.exchangeRateKesPerUsd, 130.25);
  assert.equal(settingState.exchangeRateKesPerUsd, 130.25);
  assert.equal(auditEntries.length, 1);
  assert.match(auditEntries[0].reason, /exchangeRateKesPerUsd/);
});

test("exchange rate rejects values outside range or with excess precision", async () => {
  for (const rate of [0, 1000.1, -1, "130", null, 130.12345, NaN]) {
    const { response } = await request("/api/admin/settings", {
      method: "PUT",
      role: "admin",
      body: { exchangeRateKesPerUsd: rate }
    });
    assert.equal(response.status, 400, `Expected rejection for rate ${String(rate)}`);
  }

  assert.equal(savedSettings, 0);
  assert.equal(auditEntries.length, 0);
});

test("registration is blocked when registration is disabled", async () => {
  registrationSetting = {
    registrationEnabled: false,
    maintenanceMode: false
  };

  const { response, body } = await request("/api/auth/register", {
    method: "POST",
    body: {}
  });

  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.match(body.message, /registration.*disabled/i);
});

test("registration is blocked during maintenance mode", async () => {
  registrationSetting = {
    registrationEnabled: true,
    maintenanceMode: true
  };

  const { response, body } = await request("/api/auth/register", {
    method: "POST",
    body: {}
  });

  assert.equal(response.status, 503);
  assert.match(body.message, /maintenance/i);
});

test("revenue endpoint rejects requests without a session", async () => {
  const { response } = await request("/api/admin/revenue");

  assert.equal(response.status, 401);
});

test("revenue endpoint reports verified sales and commission totals in USD", async () => {
  const { response, body } = await request(
    "/api/admin/revenue?from=2026-01-01&to=2026-01-31",
    { role: "admin" }
  );

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.currency, "USD");
  assert.equal(body.data.verifiedMembershipSales, 125.5);
  assert.equal(body.data.verifiedPurchaseCount, 2);
  assert.deepEqual(body.data.commissions, {
    pending: { amount: 10, count: 2 },
    paid: { amount: 4.5, count: 1 },
    reversed: { amount: 1, count: 1 }
  });
  assert.equal(body.data.salesLessPaidCommissions, 121);
});

test("revenue endpoint rejects invalid and reversed date ranges", async () => {
  const invalidRanges = [
    "?from=2026-02-30&to=2026-03-01",
    "?from=2026-03-02&to=2026-03-01",
    "?from=not-a-date&to=2026-03-01",
    "?from=2024-01-01&to=2026-01-01"
  ];

  for (const range of invalidRanges) {
    const { response, body } = await request(
      "/api/admin/revenue" + range,
      { role: "admin" }
    );

    assert.equal(response.status, 400);
    assert.equal(body.success, false);
  }
});
