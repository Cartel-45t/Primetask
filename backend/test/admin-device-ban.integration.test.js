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
const requireAuth = require("../src/middleware/requireAuth");
const securityChain = require("../src/services/securityEventChainService");

const {
  createDeviceCredential
} = require("../src/services/deviceCredentialService");

const {
  verifySecurityEventChain
} = securityChain;

const testUri = process.env.PTW_TEST_MONGODB_URI;
const enabled = Boolean(testUri);

process.env.JWT_SECRET =
  process.env.PTW_TEST_JWT_SECRET ||
  "ptw-device-ban-integration-test-secret";

let server;
let baseUrl;
let connected = false;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/admin/security", adminSecurityRoutes);

app.get("/__test/protected", requireAuth, (req, res) => {
  res.json({ success: true, message: "Protected route reached." });
});


async function createUser(role, suffix) {
  return User.create({
    firstName: "Device",
    lastName: "Ban Test",
    username: `${role}_${suffix}`,
    email: `${role}_${suffix}@example.test`,
    phone: `+254711${String(suffix).padStart(6, "0")}`,
    passwordHash: "integration-test-only-password-hash",
    role,
    status: "active",
    sessionVersion: 0
  });
}

async function createDevice(label) {
  const credential = createDeviceCredential();

  const device = await Device.create({
    deviceKeyHash: credential.hash,
    status: "active",
    deviceLabel: label,
    manufacturer: "Xiaomi",
    deviceModel: "Redmi 15C",
    platform: "Android",
    osVersion: "15",
    browser: "Chrome",
    browserVersion: "130.0",
    deviceType: "Mobile",
    registeredAt: new Date(),
    lastSeenAt: new Date(),
    lastKnownIp: "127.0.0.1",
    lastUserAgent: "PTW device ban integration test"
  });

  return { credential, device };
}

async function registerDevice(user, device) {
  return DeviceRegistration.create({
    userId: user._id,
    deviceId: device._id,
    status: "active",
    registeredAt: new Date(),
    lastSeenAt: new Date()
  });
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

async function createBanFixture() {
  const admin = await createUser("admin", "200001");
  const firstMember = await createUser("user", "200002");
  const secondMember = await createUser("user", "200003");
  const transferMember = await createUser("user", "200004");

  const adminBrowser = await createDevice("Administrator browser");
  await registerDevice(admin, adminBrowser.device);

  // One browser identity is registered to two different accounts.
  const sharedBrowser = await createDevice("Shared browser to ban");
  const firstRegistration = await registerDevice(
    firstMember,
    sharedBrowser.device
  );
  const secondRegistration = await registerDevice(
    secondMember,
    sharedBrowser.device
  );

  // A third account has a pending transfer request proposing that browser.
  const transferOldBrowser = await createDevice("Transfer member old browser");
  const transferOldRegistration = await registerDevice(
    transferMember,
    transferOldBrowser.device
  );

  const transfer = await DeviceTransferRequest.create({
    userId: transferMember._id,
    oldRegistrationId: transferOldRegistration._id,
    oldDeviceId: transferOldBrowser.device._id,
    proposedDeviceId: sharedBrowser.device._id,
    status: "pending",
    requestIp: "127.0.0.1",
    requestUserAgent: "PTW device ban integration test",
    requestCount: 1,
    failedAttempts: 1,
    firstRequestedAt: new Date(),
    lastRequestedAt: new Date(),
    lastAttemptAt: new Date()
  });

  return {
    admin,
    adminBrowser,
    firstMember,
    secondMember,
    transferMember,
    sharedBrowser,
    firstRegistration,
    secondRegistration,
    transferOldRegistration,
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
    `ptw_ban_test_${process.pid}_${Date.now().toString(36)}`;

  await mongoose.connect(testUri, {
    dbName: isolatedDatabase,
    serverSelectionTimeoutMS: 15000
  });

  connected = true;

  assert.equal(mongoose.connection.name, isolatedDatabase);

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

      baseUrl = `http://127.0.0.1:${server.address().port}`;
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

test("global ban revokes every account registration and cancels transfers targeting the browser", {
  skip: !enabled
}, async () => {
  const fixture = await createBanFixture();

  const response = await sendRequest(
    `/api/admin/security/devices/${fixture.sharedBrowser.device._id}/ban`,
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie(
          fixture.admin,
          fixture.adminBrowser.credential
        )
      },
      body: JSON.stringify({
        reason: "Confirmed unauthorized browser activity."
      })
    }
  );

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.status, "banned");
  assert.equal(body.data.revokedRegistrationCount, 2);
  assert.equal(body.data.cancelledTransferCount, 1);

  const device = await Device.findById(fixture.sharedBrowser.device._id);
  assert.equal(device.status, "banned");
  assert.ok(device.bannedAt);
  assert.equal(
    device.reviewedByAdminId.toString(),
    fixture.admin._id.toString()
  );

  for (const registrationId of [
    fixture.firstRegistration._id,
    fixture.secondRegistration._id
  ]) {
    const registration = await DeviceRegistration.findById(registrationId);

    assert.equal(registration.status, "revoked");
    assert.ok(registration.revokedAt);
    assert.match(registration.revokedReason, /Global device ban/);
    assert.equal(
      registration.reviewedByAdminId.toString(),
      fixture.admin._id.toString()
    );
  }

  const transfer = await DeviceTransferRequest.findById(
    fixture.transfer._id
  );

  assert.equal(transfer.status, "cancelled");
  assert.ok(transfer.cancelledAt);
  assert.equal(
    transfer.reviewedByAdminId.toString(),
    fixture.admin._id.toString()
  );

  // The unrelated original registration remains active.
  const oldRegistration = await DeviceRegistration.findById(
    fixture.transferOldRegistration._id
  );
  assert.equal(oldRegistration.status, "active");

  const event = await SecurityEvent.findOne({
    eventType: "device_banned"
  });

  assert.ok(event);
  assert.equal(event.severity, "critical");
  assert.equal(event.outcome, "success");
  assert.equal(event.actorUserId.toString(), fixture.admin._id.toString());
  assert.equal(event.deviceId.toString(), fixture.sharedBrowser.device._id.toString());

  const verification = await verifySecurityEventChain();
  assert.equal(verification.valid, true);
  assert.equal(verification.checkedEvents, 1);
});

test("unbanning restores device status but never restores revoked registrations", {
  skip: !enabled
}, async () => {
  const fixture = await createBanFixture();

  const banResponse = await sendRequest(
    `/api/admin/security/devices/${fixture.sharedBrowser.device._id}/ban`,
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie(fixture.admin, fixture.adminBrowser.credential)
      },
      body: JSON.stringify({
        reason: "Confirmed unauthorized browser activity."
      })
    }
  );

  assert.equal(banResponse.status, 200);

  const unbanResponse = await sendRequest(
    `/api/admin/security/devices/${fixture.sharedBrowser.device._id}/unban`,
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie(fixture.admin, fixture.adminBrowser.credential)
      },
      body: JSON.stringify({
        reason: "Investigation completed and ban lifted."
      })
    }
  );

  const body = await unbanResponse.json();

  assert.equal(unbanResponse.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.status, "active");
  assert.equal(body.data.registrationsRestored, false);

  const device = await Device.findById(fixture.sharedBrowser.device._id);
  assert.equal(device.status, "active");
  assert.equal(device.bannedAt, null);
  assert.equal(device.banReason, null);

  assert.equal(
    await DeviceRegistration.countDocuments({
      deviceId: fixture.sharedBrowser.device._id,
      status: "active"
    }),
    0
  );

  assert.equal(
    await DeviceRegistration.countDocuments({
      deviceId: fixture.sharedBrowser.device._id,
      status: "revoked"
    }),
    2
  );

  const events = await SecurityEvent.find({
    eventType: { $in: ["device_banned", "device_unbanned"] }
  }).sort({ sequence: 1 });

  assert.equal(events.length, 2);
  assert.equal(events[0].eventType, "device_banned");
  assert.equal(events[1].eventType, "device_unbanned");

  const verification = await verifySecurityEventChain();
  assert.equal(verification.valid, true);
  assert.equal(verification.checkedEvents, 2);
});

test("banned browser cannot access protected admin security endpoints", {
  skip: !enabled
}, async () => {
  const fixture = await createBanFixture();

  await Device.updateOne(
    { _id: fixture.sharedBrowser.device._id },
    { $set: { status: "banned", bannedAt: new Date() } }
  );

  const response = await sendRequest(
    "/api/admin/security/devices",
    {
      headers: {
        Cookie: sessionCookie(
          fixture.firstMember,
          fixture.sharedBrowser.credential
        )
      }
    }
  );

  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.code, "DEVICE_BANNED");
});

test("ordinary members cannot ban or unban devices", {
  skip: !enabled
}, async () => {
  const fixture = await createBanFixture();

  const banResponse = await sendRequest(
    `/api/admin/security/devices/${fixture.sharedBrowser.device._id}/ban`,
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie(
          fixture.firstMember,
          fixture.sharedBrowser.credential
        )
      },
      body: JSON.stringify({
        reason: "Member attempts unauthorized ban."
      })
    }
  );

  assert.equal(banResponse.status, 403);

  const unbanResponse = await sendRequest(
    `/api/admin/security/devices/${fixture.sharedBrowser.device._id}/unban`,
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie(
          fixture.firstMember,
          fixture.sharedBrowser.credential
        )
      },
      body: JSON.stringify({
        reason: "Member attempts unauthorized unban."
      })
    }
  );

  assert.equal(unbanResponse.status, 403);

  const device = await Device.findById(fixture.sharedBrowser.device._id);
  assert.equal(device.status, "active");
  assert.equal(await SecurityEvent.countDocuments({}), 0);
});

test("device inventory never exposes browser credential hashes", {
  skip: !enabled
}, async () => {
  const fixture = await createBanFixture();

  const response = await sendRequest(
    "/api/admin/security/devices",
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
  const serialized = JSON.stringify(body);

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.data.devices));

  assert.equal(serialized.includes("deviceKeyHash"), false);
  assert.equal(serialized.includes(fixture.sharedBrowser.credential.hash), false);

  const listedDevice = body.data.devices.find(
    item => item._id.toString() === fixture.sharedBrowser.device._id.toString()
  );

  assert.ok(listedDevice, "Shared device must appear in inventory");

  assert.equal(listedDevice.manufacturer, "Xiaomi");
  assert.equal(listedDevice.deviceModel, "Redmi 15C");
  assert.equal(listedDevice.platform, "Android");
  assert.equal(listedDevice.osVersion, "15");
  assert.equal(listedDevice.browser, "Chrome");
  assert.equal(listedDevice.browserVersion, "130.0");
  assert.equal(listedDevice.deviceType, "Mobile");

  assert.equal(serialized.includes("deviceKeyHash"), false);
  assert.equal(
    serialized.includes(fixture.sharedBrowser.credential.credential),
    false,
    "Raw device credentials must never appear in inventory responses"
  );
});

test("ban requires a meaningful reason and rejects repeated bans", {
  skip: !enabled
}, async () => {
  const fixture = await createBanFixture();

  const invalidResponse = await sendRequest(
    `/api/admin/security/devices/${fixture.sharedBrowser.device._id}/ban`,
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie(fixture.admin, fixture.adminBrowser.credential)
      },
      body: JSON.stringify({ reason: "no" })
    }
  );

  assert.equal(invalidResponse.status, 400);

  const firstResponse = await sendRequest(
    `/api/admin/security/devices/${fixture.sharedBrowser.device._id}/ban`,
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie(fixture.admin, fixture.adminBrowser.credential)
      },
      body: JSON.stringify({
        reason: "Confirmed unauthorized browser activity."
      })
    }
  );

  assert.equal(firstResponse.status, 200);

  const secondResponse = await sendRequest(
    `/api/admin/security/devices/${fixture.sharedBrowser.device._id}/ban`,
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie(fixture.admin, fixture.adminBrowser.credential)
      },
      body: JSON.stringify({
        reason: "Repeated ban must not be accepted."
      })
    }
  );

  assert.equal(secondResponse.status, 409);
  assert.equal(await SecurityEvent.countDocuments({ eventType: "device_banned" }), 1);
});

test("ban transaction rolls back device and registration changes if audit recording fails", {
  skip: !enabled
}, async () => {
  const fixture = await createBanFixture();

  const originalRecord = securityChain.recordSecurityEvent;

  securityChain.recordSecurityEvent = async () => {
    throw new Error("Simulated audit storage failure");
  };

  let response;

  try {
    response = await sendRequest(
      `/api/admin/security/devices/${fixture.sharedBrowser.device._id}/ban`,
      {
        method: "POST",
        headers: {
          Cookie: sessionCookie(
            fixture.admin,
            fixture.adminBrowser.credential
          )
        },
        body: JSON.stringify({
          reason: "Confirmed unauthorized browser activity."
        })
      }
    );
  } finally {
    securityChain.recordSecurityEvent = originalRecord;
  }

  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.success, false);

  const device = await Device.findById(fixture.sharedBrowser.device._id);
  assert.equal(device.status, "active");
  assert.equal(device.bannedAt, null);

  assert.equal(
    await DeviceRegistration.countDocuments({
      deviceId: fixture.sharedBrowser.device._id,
      status: "active"
    }),
    2
  );

  assert.equal(
    await DeviceTransferRequest.countDocuments({
      _id: fixture.transfer._id,
      status: "pending"
    }),
    1
  );

  assert.equal(await SecurityEvent.countDocuments({}), 0);
});


test("authorization cannot pass when a global ban commits during its device read", {
  skip: !enabled,
  timeout: 60000
}, async () => {
  const fixture = await createBanFixture();

  const originalExec = mongoose.Query.prototype.exec;

  let pauseAuthorizationRead = false;
  let authorizationReadReached;
  let releaseAuthorizationRead;

  const readReached = new Promise(resolve => {
    authorizationReadReached = resolve;
  });

  const readGate = new Promise(resolve => {
    releaseAuthorizationRead = resolve;
  });

  mongoose.Query.prototype.exec = async function (...args) {
    const result = await originalExec.apply(this, args);

    const query = this.getQuery?.() || {};
    const isTargetDeviceRead =
      this.model?.modelName === "Device" &&
      this.op === "findOne" &&
      query.deviceKeyHash === fixture.sharedBrowser.credential.hash;

    if (isTargetDeviceRead && !pauseAuthorizationRead) {
      pauseAuthorizationRead = true;
      authorizationReadReached();
      await readGate;
    }

    return result;
  };

  let protectedRequest;

  try {
    // Start a protected request and pause it after it reads the active device.
    protectedRequest = sendRequest("/__test/protected", {
      headers: {
        Cookie: sessionCookie(
          fixture.firstMember,
          fixture.sharedBrowser.credential
        )
      }
    });

    await readReached;

    // Commit the global ban while the protected request is paused.
    const banResponse = await sendRequest(
      `/api/admin/security/devices/${fixture.sharedBrowser.device._id}/ban`,
      {
        method: "POST",
        headers: {
          Cookie: sessionCookie(
            fixture.admin,
            fixture.adminBrowser.credential
          )
        },
        body: JSON.stringify({
          reason: "Race-condition integration test."
        })
      }
    );

    const banBody = await banResponse.json();

    assert.equal(banResponse.status, 200);
    assert.equal(banBody.success, true);
    assert.equal(banBody.data.status, "banned");

    // Resume authorization only after the ban transaction has committed.
    releaseAuthorizationRead();

    const protectedResponse = await protectedRequest;
    const protectedBody = await protectedResponse.json();

    assert.equal(protectedResponse.status, 403);
    assert.equal(protectedBody.code, "DEVICE_BANNED");

    const device = await Device.findById(fixture.sharedBrowser.device._id);
    assert.equal(device.status, "banned");

    const verification = await verifySecurityEventChain();
    assert.equal(verification.valid, true);
  } finally {
    // Never leave the global Mongoose query executor patched or the request paused.
    releaseAuthorizationRead();
    mongoose.Query.prototype.exec = originalExec;
  }
});
