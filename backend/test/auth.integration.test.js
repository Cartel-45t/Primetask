require("dotenv").config();

const {
  test,
  before,
  after,
  beforeEach
} = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const passwordResetEmailService = require("../src/services/passwordResetEmailService");

const testUri = process.env.PTW_TEST_MONGODB_URI;
const enabled = Boolean(testUri);

const emailVerificationService = require("../src/services/emailVerificationService");
let deliveredOtp = null;
const originalVerificationSender = emailVerificationService.sendVerificationEmail;
emailVerificationService.sendVerificationEmail = async ({ code }) => {
  deliveredOtp = code;
  return true;
};

// Never sign integration-test tokens with the production secret.
process.env.JWT_SECRET =
  process.env.PTW_TEST_JWT_SECRET ||
  "ptw-v3-integration-test-secret-only";

const User = require("../src/models/User");
const EmailVerification = require("../src/models/EmailVerification");
const SecurityEvent = require("../src/models/SecurityEvent");
const SecurityEventChain = require("../src/models/SecurityEventChain");
const Device = require("../src/models/Device");
const DeviceRegistration = require("../src/models/DeviceRegistration");
const DeviceTransferRequest = require("../src/models/DeviceTransferRequest");
const {
  verifySecurityEventChain
} = require("../src/services/securityEventChainService");
const authRoutes = require("../src/routes/auth");
const adminUsersRoutes = require("../src/routes/adminUsers");

let server;
let baseUrl;

function registration(overrides = {}) {
  return {
    firstName: "Test",
    lastName: "Worker",
    username: "test_worker",
    email: "worker@example.test",
    phone: "+254700000001",
    password: "TestPassword!123",
    termsAccepted: true,
    selectedService: "transcription",
    ...overrides
  };
}

let requestIpCounter = 1;
let currentTestIp = "198.51.100.1";

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      "X-Forwarded-For": currentTestIp,
      ...options.headers
    }
  });

  const body = await response.json();
  return { response, body };
}

async function registerUser(overrides = {}) {
  return request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(registration(overrides))
  });
}

async function registerAndVerify(overrides = {}) {
  const details = registration(overrides);
  const registered = await registerUser(overrides);
  assert.equal(registered.response.status, 201);
  assert.match(deliveredOtp || "", /^\d{6}$/);

  const verified = await request("/api/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ email: details.email, code: deliveredOtp })
  });

  assert.equal(verified.response.status, 200);
  assert.equal(verified.body.success, true);
  return registered;
}

async function loginUser(identifier, password = "TestPassword!123", cookie = "") {
  return request("/api/auth/login", {
    method: "POST",
    headers: cookie ? { Cookie: cookie } : {},
    body: JSON.stringify({ identifier, password })
  });
}

function cookieHeader(response) {
  const cookies = response.headers.getSetCookie();
  return cookies
    .map(value => value.split(";")[0])
    .join("; ");
}

function deviceCookie(response) {
  const value = response.headers.getSetCookie()
    .find(cookie => cookie.startsWith("ptw_device="));
  return value ? value.split(";")[0] : "";
}

async function assertSecurityEvents(expectedTypes) {
  const events = await SecurityEvent.find({})
    .sort({ sequence: 1 })
    .lean();

  const actualTypes = events.map(event => event.eventType);

  for (const type of expectedTypes) {
    assert.ok(
      actualTypes.includes(type),
      `Expected security event "${type}". Found: ${actualTypes.join(", ")}`
    );
  }

  const verification = await verifySecurityEventChain();

  assert.equal(
    verification.valid,
    true,
    `Security event chain invalid: ${JSON.stringify(verification)}`
  );

  assert.equal(verification.checkedEvents, events.length);

  return events.filter(event => expectedTypes.includes(event.eventType));
}

before(async () => {
  if (!enabled) return;

  let databaseName;

  try {
    databaseName = decodeURIComponent(
      new URL(testUri).pathname.replace(/^\/+/, "")
    );
  } catch {
    throw new Error(
      "PTW_TEST_MONGODB_URI must be a valid MongoDB connection URI."
    );
  }

  if (!databaseName.toLowerCase().includes("test")) {
    throw new Error(
      "Safety stop: test database name must contain 'test'."
    );
  }

  await mongoose.connect(testUri, {
    serverSelectionTimeoutMS: 10000
  });

  await User.init();
  await EmailVerification.init();
  await SecurityEvent.init();
  await SecurityEventChain.init();
  await Device.init();
  await DeviceRegistration.init();
  await DeviceTransferRequest.init();

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "20kb" }));
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use("/api/admin/users", adminUsersRoutes);

  server = app.listen(0, "127.0.0.1");

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  requestIpCounter = requestIpCounter >= 254 ? 1 : requestIpCounter + 1;
  currentTestIp = `198.51.100.${requestIpCounter}`;

  if (enabled && mongoose.connection.readyState === 1) {
    await User.deleteMany({});
    await EmailVerification.deleteMany({});
    deliveredOtp = null;
    await SecurityEvent.deleteMany({});
    await SecurityEventChain.deleteMany({});
    await Device.deleteMany({});
    await DeviceRegistration.deleteMany({});
    await DeviceTransferRequest.deleteMany({});
  }
});

after(async () => {
  emailVerificationService.sendVerificationEmail = originalVerificationSender;
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
});

test("registration creates a user without exposing the password hash", {
  skip: !enabled
}, async () => {
  const { response, body } = await registerUser();

  assert.equal(response.status, 201);
  assert.equal(body.success, true);
  assert.equal(body.user.username, "test_worker");
  assert.equal(Object.hasOwn(body.user, "passwordHash"), false);
});

test("unverified registration cannot log in or register a device", {
  skip: !enabled
}, async () => {
  const registered = await registerUser();
  assert.equal(registered.response.status, 201);
  assert.equal(registered.body.verificationRequired, true);

  const account = await User.findOne({ username: "test_worker" });
  assert.ok(account);
  assert.equal(account.emailVerified, false);
  assert.equal(account.emailVerificationRequired, true);

  const login = await loginUser("test_worker");
  assert.equal(login.response.status, 403);
  assert.equal(login.body.code, "EMAIL_NOT_VERIFIED");

  assert.equal(await Device.countDocuments({}), 0);
  assert.equal(await DeviceRegistration.countDocuments({}), 0);
  assert.equal(await DeviceTransferRequest.countDocuments({}), 0);
  assert.equal(login.response.headers.getSetCookie().some(
    value => value.startsWith("ptw_session=")
  ), false);
});

test("valid email OTP verifies the account and cannot be reused", {
  skip: !enabled
}, async () => {
  const registered = await registerUser();
  assert.equal(registered.response.status, 201);

  const code = deliveredOtp;
  assert.match(code || "", /^\d{6}$/);

  const verified = await request("/api/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ email: "worker@example.test", code })
  });

  assert.equal(verified.response.status, 200);
  assert.equal(verified.body.success, true);

  const account = await User.findOne({ username: "test_worker" });
  assert.equal(account.emailVerified, true);

  const replay = await request("/api/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ email: "worker@example.test", code })
  });

  assert.equal(replay.response.status, 400);

  const login = await loginUser("test_worker");
  assert.equal(login.response.status, 200);
});

test("incorrect email OTP is rejected", {
  skip: !enabled
}, async () => {
  await registerUser();

  const result = await request("/api/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({
      email: "worker@example.test",
      code: deliveredOtp === "000000" ? "000001" : "000000"
    })
  });

  assert.equal(result.response.status, 400);

  const account = await User.findOne({ username: "test_worker" });
  assert.equal(account.emailVerified, false);
});

test("duplicate email or username is rejected", {
  skip: !enabled
}, async () => {
  const first = await registerUser();
  assert.equal(first.response.status, 201);

  const duplicate = await registerUser({
    username: "another_worker",
    phone: "+254700000002"
  });

  assert.equal(duplicate.response.status, 409);
});

test("invalid registration input is rejected", {
  skip: !enabled
}, async () => {
  const { response } = await registerUser({
    password: "short"
  });

  assert.equal(response.status, 400);
});

test("valid login creates a session and /me returns the account", {
  skip: !enabled
}, async () => {
  await registerAndVerify();

  const pictureUrl =
    "https://res.cloudinary.com/example/image/upload/test-profile.jpg";

  const account = await User.findOne({ username: "test_worker" });
  assert.ok(account, "Test account should exist");

  account.profilePictureUrl = pictureUrl;
  await account.save();

  const login = await loginUser("WORKER@EXAMPLE.TEST");

  assert.equal(login.response.status, 200);
  assert.equal(login.body.success, true);

  const loginEvents = await assertSecurityEvents([
    "device_registered",
    "login_success"
  ]);
  assert.equal(loginEvents.length, 2);
  assert.equal(loginEvents[0].eventType, "device_registered");
  assert.equal(loginEvents[1].outcome, "success");

  const registeredDevice = await Device.findOne({});
  const registrationRecord = await DeviceRegistration.findOne({
    userId: account._id,
    status: "active"
  });

  assert.ok(registeredDevice);
  assert.ok(registrationRecord);
  assert.equal(
    registrationRecord.deviceId.toString(),
    registeredDevice._id.toString()
  );
  assert.match(deviceCookie(login.response), /^ptw_device=/);

  const cookie = cookieHeader(login.response);
  assert.match(cookie, /(?:^|;\s*)ptw_session=/);

  const me = await request("/api/auth/me", {
    headers: { Cookie: cookie }
  });

  assert.equal(me.response.status, 200);
  assert.equal(me.body.user.username, "test_worker");
  assert.equal(me.body.user.profilePictureUrl, pictureUrl);
  assert.equal(Object.hasOwn(me.body.user, "passwordHash"), false);
});

test("same registered browser can log in repeatedly", {
  skip: !enabled
}, async () => {
  await registerAndVerify();

  const first = await loginUser("test_worker");
  assert.equal(first.response.status, 200);

  const second = await loginUser(
    "test_worker",
    "TestPassword!123",
    cookieHeader(first.response)
  );

  assert.equal(second.response.status, 200);
  assert.equal(
    await DeviceRegistration.countDocuments({ status: "active" }),
    1
  );
  assert.equal(await DeviceTransferRequest.countDocuments({}), 0);
});

test("a second browser is blocked and creates an admin-review transfer request", {
  skip: !enabled
}, async () => {
  await registerAndVerify();

  const original = await loginUser("test_worker");
  assert.equal(original.response.status, 200);

  const secondBrowser = await loginUser("test_worker");
  assert.equal(secondBrowser.response.status, 403);
  assert.equal(secondBrowser.body.code, "DEVICE_TRANSFER_PENDING");
  assert.match(deviceCookie(secondBrowser.response), /^ptw_device=/);

  let transfer = await DeviceTransferRequest.findOne({
    status: "pending"
  });

  assert.ok(transfer);
  assert.equal(transfer.requestCount, 1);
  assert.equal(transfer.failedAttempts, 1);

  const repeatedAttempt = await loginUser(
    "test_worker",
    "TestPassword!123",
    cookieHeader(secondBrowser.response)
  );

  assert.equal(repeatedAttempt.response.status, 403);
  assert.equal(repeatedAttempt.body.code, "DEVICE_TRANSFER_PENDING");

  transfer = await DeviceTransferRequest.findById(transfer._id);
  assert.equal(transfer.requestCount, 2);
  assert.equal(transfer.failedAttempts, 2);

  const oldBrowserStillWorks = await request("/api/auth/me", {
    headers: { Cookie: cookieHeader(original.response) }
  });

  assert.equal(oldBrowserStillWorks.response.status, 200);
  assert.equal(
    await DeviceRegistration.countDocuments({ status: "active" }),
    1
  );

  await assertSecurityEvents([
    "device_registered",
    "login_success",
    "device_transfer_requested",
    "device_transfer_failed"
  ]);
});

test("a revoked device cannot silently register a replacement browser", {
  skip: !enabled
}, async () => {
  await registerAndVerify();

  const original = await loginUser("test_worker");
  assert.equal(original.response.status, 200);

  const account = await User.findOne({ username: "test_worker" });
  assert.ok(account);

  const originalRegistration = await DeviceRegistration.findOne({
    userId: account._id,
    status: "active"
  });

  assert.ok(originalRegistration);

  originalRegistration.status = "revoked";
  originalRegistration.revokedAt = new Date();
  originalRegistration.revokedReason = "Test revocation";
  await originalRegistration.save();

  const replacementBrowser = await loginUser("test_worker");

  assert.equal(replacementBrowser.response.status, 403);
  assert.equal(
    replacementBrowser.body.code,
    "DEVICE_TRANSFER_PENDING"
  );

  const activeRegistrations = await DeviceRegistration.countDocuments({
    userId: account._id,
    status: "active"
  });

  assert.equal(activeRegistrations, 0);

  assert.equal(
    await DeviceRegistration.countDocuments({ userId: account._id }),
    1
  );

  const transfer = await DeviceTransferRequest.findOne({
    userId: account._id,
    status: "pending"
  });

  assert.ok(transfer);
  assert.equal(
    transfer.oldRegistrationId.toString(),
    originalRegistration._id.toString()
  );
  assert.equal(
    transfer.oldDeviceId.toString(),
    originalRegistration.deviceId.toString()
  );
  assert.equal(transfer.requestCount, 1);

  const events = await assertSecurityEvents([
    "device_registered",
    "login_success",
    "device_transfer_requested"
  ]);

  assert.equal(
    events.filter(event => event.eventType === "device_registered").length,
    1
  );
});

test("wrong password is rejected", {
  skip: !enabled
}, async () => {
  await registerUser();

  const { response, body } = await loginUser(
    "test_worker",
    "DefinitelyWrongPassword!123"
  );

  assert.equal(response.status, 401);
  assert.equal(body.success, false);

  const events = await assertSecurityEvents(["login_failed"]);
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "denied");
});

test("suspended account cannot log in", {
  skip: !enabled
}, async () => {
  await User.create({
    ...registration(),
    passwordHash: await bcrypt.hash("TestPassword!123", 12),
    status: "suspended"
  });

  const { response } = await loginUser("test_worker");

  assert.equal(response.status, 403);

  const events = await assertSecurityEvents(["login_failed"]);
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "denied");
});

test("session endpoint rejects missing and invalid cookies", {
  skip: !enabled
}, async () => {
  const missing = await request("/api/auth/me");
  assert.equal(missing.response.status, 401);

  const invalid = await request("/api/auth/me", {
    headers: { Cookie: "ptw_session=not-a-valid-token" }
  });

  assert.equal(invalid.response.status, 401);
});

test("logout records an event and clears the session cookie", {
  skip: !enabled
}, async () => {
  await registerAndVerify();

  const login = await loginUser("test_worker");
  assert.equal(login.response.status, 200);

  const result = await request("/api/auth/logout", {
    method: "POST",
    headers: { Cookie: cookieHeader(login.response) }
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.body.success, true);

  const cookie = result.response.headers.get("set-cookie") || "";
  assert.match(cookie, /ptw_session=/);
  assert.match(cookie, /Expires=/i);

  const events = await assertSecurityEvents([
    "device_registered",
    "login_success",
    "logout"
  ]);

  assert.equal(events.length, 3);
  assert.equal(events[2].outcome, "success");
});

test("ordinary user cannot access admin user management", {
  skip: !enabled
}, async () => {
  await registerAndVerify();

  const login = await loginUser("test_worker");
  assert.equal(login.response.status, 200);

  const result = await request("/api/admin/users", {
    headers: { Cookie: cookieHeader(login.response) }
  });

  assert.equal(result.response.status, 403);
});


test("password recovery returns a generic response for unknown emails", {
  skip: !enabled
}, async () => {
  const result = await request("/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email: "nobody@example.test" })
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.body.success, true);
  assert.match(result.body.message, /if an account exists/i);

  const events = await assertSecurityEvents([
    "password_reset_requested"
  ]);

  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "pending");
  assert.equal(events[0].userId, null);
});

test("password reset is single-use and invalidates existing sessions", {
  skip: !enabled
}, async () => {
  const registered = await registerAndVerify();
  assert.equal(registered.response.status, 201);

  const login = await loginUser("test_worker");
  assert.equal(login.response.status, 200);
  const oldCookie = cookieHeader(login.response);

  let deliveredToken;
  const originalSender = passwordResetEmailService.sendPasswordResetEmail;

  passwordResetEmailService.sendPasswordResetEmail = async payload => {
    deliveredToken = payload.token;
  };

  try {
    const forgot = await request("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: "WORKER@EXAMPLE.TEST" })
    });

    assert.equal(forgot.response.status, 200);
    assert.equal(forgot.body.success, true);
    assert.match(deliveredToken || "", /^[a-f0-9]{64}$/);

    const storedUser = await User.findOne({
      email: "worker@example.test"
    }).select("+passwordResetTokenHash +passwordResetExpiresAt");

    assert.ok(storedUser);
    assert.notEqual(storedUser.passwordResetTokenHash, deliveredToken);
    assert.ok(storedUser.passwordResetExpiresAt > new Date());

    const newPassword = "ChangedPassword!456";
    const reset = await request("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({
        token: deliveredToken,
        password: newPassword
      })
    });

    assert.equal(reset.response.status, 200);
    assert.equal(reset.body.success, true);

    const replay = await request("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({
        token: deliveredToken,
        password: newPassword
      })
    });

    assert.equal(replay.response.status, 400);

    const oldSession = await request("/api/auth/me", {
      headers: { Cookie: oldCookie }
    });
    assert.equal(oldSession.response.status, 401);

    const newLogin = await loginUser(
      "test_worker",
      newPassword,
      deviceCookie(login.response)
    );
    assert.equal(newLogin.response.status, 200);
    assert.equal(newLogin.body.success, true);

    const events = await assertSecurityEvents([
      "login_success",
      "password_reset_requested",
      "password_reset_completed",
      "session_revoked"
    ]);

    assert.equal(
      events.filter(event => event.eventType === "login_success").length,
      2
    );
    assert.equal(
      events.filter(event => event.eventType === "password_reset_requested").length,
      1
    );
    assert.equal(
      events.filter(event => event.eventType === "password_reset_completed").length,
      1
    );
    assert.equal(
      events.filter(event => event.eventType === "session_revoked").length,
      1
    );
  } finally {
    passwordResetEmailService.sendPasswordResetEmail = originalSender;
  }
});

test("expired password reset token is rejected without changing the password", {
  skip: !enabled
}, async () => {
  const registered = await registerAndVerify();
  assert.equal(registered.response.status, 201);

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const user = await User.findOne({ email: "worker@example.test" });
  assert.ok(user);

  user.passwordResetTokenHash = tokenHash;
  user.passwordResetExpiresAt = new Date(Date.now() - 60_000);
  await user.save();

  const reset = await request("/api/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({
      token: rawToken,
      password: "ChangedPassword!456"
    })
  });

  assert.equal(reset.response.status, 400);

  const oldPasswordLogin = await loginUser("test_worker");
  assert.equal(oldPasswordLogin.response.status, 200);
});

test("password recovery clears reset credentials if email delivery fails", {
  skip: !enabled
}, async () => {
  const registered = await registerUser();
  assert.equal(registered.response.status, 201);

  const originalSender = passwordResetEmailService.sendPasswordResetEmail;
  passwordResetEmailService.sendPasswordResetEmail = async () => {
    throw new Error("Simulated email delivery failure");
  };

  try {
    const result = await request("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: "worker@example.test" })
    });

    assert.equal(result.response.status, 200);
    assert.equal(result.body.success, true);

    const user = await User.findOne({
      email: "worker@example.test"
    }).select("+passwordResetTokenHash +passwordResetExpiresAt");

    assert.ok(user);
    assert.ok(!user.passwordResetTokenHash);
    assert.ok(!user.passwordResetExpiresAt);

    const events = await assertSecurityEvents([
      "password_reset_requested"
    ]);

    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, "failed");
  } finally {
    passwordResetEmailService.sendPasswordResetEmail = originalSender;
  }
});
