"use strict";

const {
  test,
  before,
  after,
  beforeEach,
  afterEach
} = require("node:test");

const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET =
  "ptw-security-route-test-secret-only-123456";

const User = require("../src/models/User");
const securityChain = require("../src/services/securityEventChainService");
const deviceAccessService = require("../src/services/deviceAccessService");
const securityRoutes = require("../src/routes/adminSecurity");

const originalFindById = User.findById;
const originalVerify = securityChain.verifySecurityEventChain;
const originalAuthorizeRequestDevice = deviceAccessService.authorizeRequestDevice;

const userId = "507f1f77bcf86cd799439011";

let server;
let baseUrl;
let currentRole;
let verificationResult;
let verificationError;
let verificationCalls;

function cookieFor() {
  const token = jwt.sign(
    { sub: userId },
    process.env.JWT_SECRET,
    {
      expiresIn: "5m",
      issuer: "primetask-workspace",
      audience: "primetask-workspace-users"
    }
  );

  return `ptw_session=${token}; ptw_device=${"A".repeat(43)}`;
}

async function request(path, authenticated = true) {
  const headers = {};

  if (authenticated) {
    headers.Cookie = cookieFor();
  }

  const response = await fetch(baseUrl + path, { headers });

  return {
    response,
    body: await response.json()
  };
}

before(async () => {
  const app = express();

  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/admin/security", securityRoutes);

  server = app.listen(0, "127.0.0.1");

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  currentRole = "admin";
  verificationResult = {
    valid: true,
    status: "valid",
    checkedEvents: 5
  };
  verificationError = null;
  verificationCalls = 0;

  User.findById = () => ({
    select: async () => ({
      _id: userId,
      role: currentRole,
      status: "active",
      sessionVersion: 0
    })
  });

  deviceAccessService.authorizeRequestDevice = async () => ({
    allowed: true,
    deviceId: "507f1f77bcf86cd799439012"
  });

  securityChain.verifySecurityEventChain = async () => {
    verificationCalls++;

    if (verificationError) throw verificationError;

    return verificationResult;
  };
});

afterEach(() => {
  User.findById = originalFindById;
  securityChain.verifySecurityEventChain = originalVerify;
  deviceAccessService.authorizeRequestDevice = originalAuthorizeRequestDevice;
});

after(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
});

test("rejects requests without a session", async () => {
  const { response, body } = await request(
    "/api/admin/security/chain/verify",
    false
  );

  assert.equal(response.status, 401);
  assert.equal(body.success, false);
  assert.equal(verificationCalls, 0);
});

test("denies ordinary members", async () => {
  currentRole = "user";

  const { response, body } = await request(
    "/api/admin/security/chain/verify"
  );

  assert.equal(response.status, 403);
  assert.equal(body.success, false);
  assert.equal(verificationCalls, 0);
});

test("allows administrators to verify the chain", async () => {
  currentRole = "admin";

  const { response, body } = await request(
    "/api/admin/security/chain/verify"
  );

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.data, {
    valid: true,
    status: "valid",
    checkedEvents: 5
  });
  assert.equal(verificationCalls, 1);
});

test("allows founders to verify the chain", async () => {
  currentRole = "founder";

  const { response, body } = await request(
    "/api/admin/security/chain/verify"
  );

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(verificationCalls, 1);
});

test("reports detected chain corruption without exposing hashes", async () => {
  verificationResult = {
    valid: false,
    status: "corrupt",
    checkedEvents: 4,
    reason: "event_hash_mismatch",
    sequence: 3,
    eventHash: "secret-hash-must-not-be-exposed"
  };

  const { response, body } = await request(
    "/api/admin/security/chain/verify"
  );

  assert.equal(response.status, 409);
  assert.equal(body.success, false);
  assert.equal(body.data.reason, "event_hash_mismatch");
  assert.equal(body.data.sequence, 3);
  assert.equal(
    JSON.stringify(body).includes("secret-hash-must-not-be-exposed"),
    false
  );
});

test("returns a generic service error if verification fails", async () => {
  verificationError = new Error("Private database connection details");

  const { response, body } = await request(
    "/api/admin/security/chain/verify"
  );

  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.equal(
    JSON.stringify(body).includes("Private database connection details"),
    false
  );
});
