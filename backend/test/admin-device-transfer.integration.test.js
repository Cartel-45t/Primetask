"use strict";

require("dotenv").config({
  path: require("node:path").resolve(__dirname, "../.env")
});

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const User = require("../src/models/User");
const Device = require("../src/models/Device");
const DeviceRegistration = require("../src/models/DeviceRegistration");
const DeviceTransferRequest = require("../src/models/DeviceTransferRequest");
const SecurityEvent = require("../src/models/SecurityEvent");
const SecurityEventChain = require("../src/models/SecurityEventChain");

const adminSecurityRoutes = require("../src/routes/adminSecurity");

const {
  createDeviceCredential
} = require("../src/services/deviceCredentialService");

const {
  verifySecurityEventChain
} = require("../src/services/securityEventChainService");

const testUri = process.env.PTW_TEST_MONGODB_URI;
const enabled = Boolean(testUri);

process.env.JWT_SECRET =
  process.env.PTW_TEST_JWT_SECRET ||
  "ptw-device-transfer-integration-test-secret";

let server;
let baseUrl;
let connected = false;

const app = express();

app.use(express.json());
app.use(cookieParser());
app.use("/api/admin/security", adminSecurityRoutes);

async function createUser(role, suffix) {
  return User.create({
    firstName: "Integration",
    lastName: "Test",
    username: `${role}_${suffix}`,
    email: `${role}_${suffix}@example.test`,
    phone: `+254700${String(suffix).padStart(6, "0")}`,
    passwordHash: "integration-test-only-password-hash",
    role,
    status: "active",
    sessionVersion: 0
  });
}

async function createRegisteredBrowser(user, label) {
  const credential = createDeviceCredential();

  const device = await Device.create({
    deviceKeyHash: credential.hash,
    status: "active",
    deviceLabel: label,
    registeredAt: new Date(),
    lastSeenAt: new Date(),
    lastKnownIp: "127.0.0.1",
    lastUserAgent: "PTW integration test"
  });

  const registration = await DeviceRegistration.create({
    userId: user._id,
    deviceId: device._id,
    status: "active",
    registeredAt: new Date(),
    lastSeenAt: new Date()
  });

  return { credential, device, registration };
}

function sessionCookie(user, credential) {
  const token = jwt.sign(
    {
      sub: user._id.toString(),
      role: user.role,
      sv: user.sessionVersion
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "10m",
      issuer: "primetask-workspace",
      audience: "primetask-workspace-users"
    }
  );

  return `ptw_session=${token}; ptw_device=${credential.credential}`;
}

async function sendRequest(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
}

async function createTransferFixture() {
  const admin = await createUser("admin", "100001");
  const member = await createUser("user", "100002");

  const adminBrowser = await createRegisteredBrowser(
    admin,
    "Administrator browser"
  );

  const oldBrowser = await createRegisteredBrowser(
    member,
    "Original member browser"
  );

  // A proposed browser is a device identity only.
  // It must not have an active account registration before approval.
  const proposedCredential = createDeviceCredential();

  const proposedDevice = await Device.create({
    deviceKeyHash: proposedCredential.hash,
    status: "active",
    deviceLabel: "Proposed member browser",
    registeredAt: new Date(),
    lastSeenAt: new Date(),
    lastKnownIp: "127.0.0.1",
    lastUserAgent: "PTW transfer integration test"
  });

  const proposedBrowser = {
    credential: proposedCredential,
    device: proposedDevice
  };

  const transfer = await DeviceTransferRequest.create({
    userId: member._id,
    oldRegistrationId: oldBrowser.registration._id,
    oldDeviceId: oldBrowser.device._id,
    proposedDeviceId: proposedBrowser.device._id,
    status: "pending",
    requestIp: "127.0.0.1",
    requestUserAgent: "PTW transfer integration test",
    requestCount: 1,
    failedAttempts: 1,
    firstRequestedAt: new Date(),
    lastRequestedAt: new Date(),
    lastAttemptAt: new Date()
  });

  return {
    admin,
    member,
    adminBrowser,
    oldBrowser,
    proposedBrowser,
    transfer
  };
}

before(async () => {
  if (!enabled) return;

  const parsed = new URL(testUri);
  const baseDatabase = decodeURIComponent(parsed.pathname.slice(1));

  assert.match(
    baseDatabase,
    /test/i,
    "PTW_TEST_MONGODB_URI must point to a database whose name contains 'test'."
  );

  const isolatedDatabase =
    `ptw_test_${process.pid}_${Date.now().toString(36)}`;

  await mongoose.connect(testUri, {
    dbName: isolatedDatabase,
    serverSelectionTimeoutMS: 15000
  });

  connected = true;

  assert.equal(
    mongoose.connection.name,
    isolatedDatabase,
    "The suite must use its isolated database."
  );

  await Promise.all([
    User.init(),
    Device.init(),
    DeviceRegistration.init(),
    DeviceTransferRequest.init(),
    SecurityEvent.init(),
    SecurityEventChain.init()
  ]);

  await new Promise((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", error => {
      if (error) return reject(error);

      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

beforeEach(async () => {
  if (!enabled || !connected) return;

  await Promise.all([
    User.deleteMany({}),
    Device.deleteMany({}),
    DeviceRegistration.deleteMany({}),
    DeviceTransferRequest.deleteMany({}),
    SecurityEvent.deleteMany({}),
    SecurityEventChain.deleteMany({})
  ]);
});

after(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }

  if (connected) {
    try {
      await mongoose.connection.dropDatabase();
    } finally {
      await mongoose.disconnect();
      connected = false;
    }
  }
});

test("admin approval atomically transfers the account to the proposed browser", {
  skip: !enabled
}, async () => {
  const fixture = await createTransferFixture();

  const response = await sendRequest(
    `/api/admin/security/devices/transfers/${fixture.transfer._id}/approve`,
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie(
          fixture.admin,
          fixture.adminBrowser.credential
        )
      },
      body: JSON.stringify({
        reason: "Member verified identity and requested a browser replacement."
      })
    }
  );

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);

  const oldRegistration = await DeviceRegistration.findById(
    fixture.oldBrowser.registration._id
  );

  const newRegistration = await DeviceRegistration.findOne({
    userId: fixture.member._id,
    deviceId: fixture.proposedBrowser.device._id,
    status: "active"
  });

  const transfer = await DeviceTransferRequest.findById(
    fixture.transfer._id
  );

  assert.equal(oldRegistration.status, "revoked");
  assert.ok(oldRegistration.revokedAt);
  assert.ok(newRegistration);
  assert.equal(transfer.status, "approved");
  assert.equal(
    transfer.reviewedByAdminId.toString(),
    fixture.admin._id.toString()
  );

  assert.equal(
    await DeviceRegistration.countDocuments({
      userId: fixture.member._id,
      status: "active"
    }),
    1
  );

  const event = await SecurityEvent.findOne({
    eventType: "device_transfer_completed"
  });

  assert.ok(event);
  assert.equal(event.outcome, "success");
  assert.equal(event.actorUserId.toString(), fixture.admin._id.toString());

  const verification = await verifySecurityEventChain();

  assert.equal(verification.valid, true);
  assert.equal(verification.checkedEvents, 1);

  // Approval must not globally ban the old browser identity.
  const oldDevice = await Device.findById(fixture.oldBrowser.device._id);
  assert.equal(oldDevice.status, "active");
});

test("admin rejection preserves the original active browser", {
  skip: !enabled
}, async () => {
  const fixture = await createTransferFixture();

  const response = await sendRequest(
    `/api/admin/security/devices/transfers/${fixture.transfer._id}/reject`,
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie(
          fixture.admin,
          fixture.adminBrowser.credential
        )
      },
      body: JSON.stringify({
        reason: "The submitted transfer request could not be verified."
      })
    }
  );

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);

  const oldRegistration = await DeviceRegistration.findById(
    fixture.oldBrowser.registration._id
  );

  const transfer = await DeviceTransferRequest.findById(
    fixture.transfer._id
  );

  assert.equal(oldRegistration.status, "active");
  assert.equal(oldRegistration.revokedAt, null);
  assert.equal(transfer.status, "rejected");
  assert.equal(
    transfer.reviewedByAdminId.toString(),
    fixture.admin._id.toString()
  );

  assert.equal(
    await DeviceRegistration.countDocuments({
      userId: fixture.member._id,
      status: "active"
    }),
    1
  );

  const event = await SecurityEvent.findOne({
    eventType: "device_transfer_rejected"
  });

  assert.ok(event);
  assert.equal(event.outcome, "denied");

  const verification = await verifySecurityEventChain();

  assert.equal(verification.valid, true);
  assert.equal(verification.checkedEvents, 1);
});

test("approval refuses a banned proposed browser without changing the old registration", {
  skip: !enabled
}, async () => {
  const fixture = await createTransferFixture();

  await Device.updateOne(
    { _id: fixture.proposedBrowser.device._id },
    { $set: { status: "banned", bannedAt: new Date() } }
  );

  const response = await sendRequest(
    `/api/admin/security/devices/transfers/${fixture.transfer._id}/approve`,
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie(
          fixture.admin,
          fixture.adminBrowser.credential
        )
      },
      body: JSON.stringify({
        reason: "Attempted approval for a banned browser."
      })
    }
  );

  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.success, false);

  const oldRegistration = await DeviceRegistration.findById(
    fixture.oldBrowser.registration._id
  );

  const transfer = await DeviceTransferRequest.findById(
    fixture.transfer._id
  );

  assert.equal(oldRegistration.status, "active");
  assert.equal(transfer.status, "pending");
  assert.equal(await SecurityEvent.countDocuments({}), 0);
});

test("approval refuses a changed original registration and preserves the current browser", {
  skip: !enabled
}, async () => {
  const fixture = await createTransferFixture();

  await DeviceRegistration.updateOne(
    { _id: fixture.oldBrowser.registration._id },
    {
      $set: {
        status: "revoked",
        revokedAt: new Date(),
        revokedReason: "Changed during test"
      }
    }
  );

  const replacementBrowser = await createRegisteredBrowser(
    fixture.member,
    "Different currently active browser"
  );

  const response = await sendRequest(
    `/api/admin/security/devices/transfers/${fixture.transfer._id}/approve`,
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie(
          fixture.admin,
          fixture.adminBrowser.credential
        )
      },
      body: JSON.stringify({
        reason: "Check for stale original registration."
      })
    }
  );

  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.success, false);

  const transfer = await DeviceTransferRequest.findById(
    fixture.transfer._id
  );

  assert.equal(transfer.status, "pending");

  assert.equal(
    await DeviceRegistration.countDocuments({
      userId: fixture.member._id,
      status: "active"
    }),
    1
  );

  const currentRegistration = await DeviceRegistration.findById(
    replacementBrowser.registration._id
  );

  assert.equal(currentRegistration.status, "active");
  assert.equal(await SecurityEvent.countDocuments({}), 0);
});

test("ordinary members cannot approve device transfers", {
  skip: !enabled
}, async () => {
  const fixture = await createTransferFixture();

  // Remove the original registration before creating the replacement.
  await DeviceRegistration.deleteOne({
    _id: fixture.oldBrowser.registration._id
  });

  const memberBrowser = await createRegisteredBrowser(
    fixture.member,
    "Member's authorized browser"
  );

  const response = await sendRequest(
    `/api/admin/security/devices/transfers/${fixture.transfer._id}/approve`,
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie(
          fixture.member,
          memberBrowser.credential
        )
      },
      body: JSON.stringify({
        reason: "Member must not approve their own transfer."
      })
    }
  );

  assert.equal(response.status, 403);

  const transfer = await DeviceTransferRequest.findById(
    fixture.transfer._id
  );

  assert.equal(transfer.status, "pending");
  assert.equal(await SecurityEvent.countDocuments({}), 0);
});

test("approval requires a meaningful review reason", {
  skip: !enabled
}, async () => {
  const fixture = await createTransferFixture();

  const response = await sendRequest(
    `/api/admin/security/devices/transfers/${fixture.transfer._id}/approve`,
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie(
          fixture.admin,
          fixture.adminBrowser.credential
        )
      },
      body: JSON.stringify({ reason: "no" })
    }
  );

  assert.equal(response.status, 400);

  const transfer = await DeviceTransferRequest.findById(
    fixture.transfer._id
  );

  assert.equal(transfer.status, "pending");
  assert.equal(await SecurityEvent.countDocuments({}), 0);
});

test("pending transfer listing returns safe device details without credential hashes", {
  skip: !enabled
}, async () => {
  const fixture = await createTransferFixture();

  const response = await sendRequest(
    "/api/admin/security/devices/transfers",
    {
      headers: {
        Cookie: sessionCookie(
          fixture.admin,
          fixture.adminBrowser.credential
        )
      }
    }
  );

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.requests.length, 1);

  const listed = body.data.requests[0];

  assert.equal(listed.status, "pending");
  assert.equal(listed.userId.username, fixture.member.username);
  assert.equal(
    listed.oldDeviceId._id.toString(),
    fixture.oldBrowser.device._id.toString()
  );
  assert.equal(
    listed.proposedDeviceId._id.toString(),
    fixture.proposedBrowser.device._id.toString()
  );

  assert.equal(
    Object.hasOwn(listed.oldDeviceId, "deviceKeyHash"),
    false
  );

  assert.equal(
    Object.hasOwn(listed.proposedDeviceId, "deviceKeyHash"),
    false
  );
});
