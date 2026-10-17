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

const testUri = process.env.PTW_TEST_MONGODB_URI;
const enabled = Boolean(testUri);

// Never sign integration-test tokens with the production secret.
process.env.JWT_SECRET =
  process.env.PTW_TEST_JWT_SECRET ||
  "ptw-v3-integration-test-secret-only";

const User = require("../src/models/User");
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

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
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

async function loginUser(identifier, password = "TestPassword!123") {
  return request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ identifier, password })
  });
}

function sessionCookie(response) {
  const value = response.headers.get("set-cookie") || "";
  return value.split(";")[0];
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

  const app = express();
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
  if (enabled && mongoose.connection.readyState === 1) {
    await User.deleteMany({});
  }
});

after(async () => {
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
  await registerUser();

  const login = await loginUser("WORKER@EXAMPLE.TEST");

  assert.equal(login.response.status, 200);
  assert.equal(login.body.success, true);

  const cookie = sessionCookie(login.response);
  assert.match(cookie, /^ptw_session=/);

  const me = await request("/api/auth/me", {
    headers: { Cookie: cookie }
  });

  assert.equal(me.response.status, 200);
  assert.equal(me.body.user.username, "test_worker");
  assert.equal(Object.hasOwn(me.body.user, "passwordHash"), false);
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

test("logout clears the session cookie", {
  skip: !enabled
}, async () => {
  const { response, body } = await request("/api/auth/logout", {
    method: "POST"
  });

  assert.equal(response.status, 200);
  assert.equal(body.success, true);

  const cookie = response.headers.get("set-cookie") || "";
  assert.match(cookie, /ptw_session=/);
  assert.match(cookie, /Expires=/i);
});

test("ordinary user cannot access admin user management", {
  skip: !enabled
}, async () => {
  await registerUser();

  const login = await loginUser("test_worker");
  assert.equal(login.response.status, 200);

  const result = await request("/api/admin/users", {
    headers: { Cookie: sessionCookie(login.response) }
  });

  assert.equal(result.response.status, 403);
});
