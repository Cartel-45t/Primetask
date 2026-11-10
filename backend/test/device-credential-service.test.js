"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const service = require("../src/services/deviceCredentialService");

test("generates a cryptographically random device credential", () => {
  const first = service.createDeviceCredential();
  const second = service.createDeviceCredential();

  assert.match(first.credential, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.hash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.credential, second.credential);
  assert.notEqual(first.hash, second.hash);
});

test("hashes credentials deterministically without storing raw values", () => {
  const generated = service.createDeviceCredential();

  assert.equal(
    service.hashDeviceCredential(generated.credential),
    generated.hash
  );

  assert.notEqual(generated.hash, generated.credential);
});

test("rejects malformed device credentials", () => {
  for (const value of [
    null,
    undefined,
    "",
    "short",
    "x".repeat(42),
    "x".repeat(44),
    "x".repeat(42) + "!"
  ]) {
    assert.throws(
      () => service.hashDeviceCredential(value),
      TypeError
    );
  }
});

test("device cookie uses secure HTTP-only settings in production", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    const options = service.deviceCookieOptions();

    assert.equal(options.httpOnly, true);
    assert.equal(options.secure, true);
    assert.equal(options.sameSite, "none");
    assert.equal(options.path, "/");
    assert.equal(options.maxAge, 365 * 24 * 60 * 60 * 1000);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("device cookie uses local-development settings outside production", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";

  try {
    const options = service.deviceCookieOptions();

    assert.equal(options.httpOnly, true);
    assert.equal(options.secure, false);
    assert.equal(options.sameSite, "lax");
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("sets the device cookie without exposing it to JavaScript", () => {
  const generated = service.createDeviceCredential();
  let captured = null;

  const response = {
    cookie(name, value, options) {
      captured = { name, value, options };
    }
  };

  service.setDeviceCookie(response, generated.credential);

  assert.equal(captured.name, "ptw_device");
  assert.equal(captured.value, generated.credential);
  assert.equal(captured.options.httpOnly, true);
});

test("clears only the device cookie using matching cookie scope", () => {
  let captured = null;

  const response = {
    clearCookie(name, options) {
      captured = { name, options };
    }
  };

  service.clearDeviceCookie(response);

  assert.equal(captured.name, "ptw_device");
  assert.equal(captured.options.path, "/");
  assert.equal(captured.options.httpOnly, true);
});

test("does not set a cookie for an invalid credential", () => {
  let called = false;

  const response = {
    cookie() {
      called = true;
    }
  };

  assert.throws(
    () => service.setDeviceCookie(response, "invalid"),
    TypeError
  );

  assert.equal(called, false);
});
