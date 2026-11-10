"use strict";

const crypto = require("node:crypto");

const DEVICE_COOKIE_NAME = "ptw_device";
const DEVICE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000;

function createDeviceCredential() {
  const credential = crypto.randomBytes(32).toString("base64url");

  return {
    credential,
    hash: hashDeviceCredential(credential)
  };
}

function hashDeviceCredential(credential) {
  if (
    typeof credential !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(credential)
  ) {
    throw new TypeError("Invalid device credential.");
  }

  return crypto
    .createHash("sha256")
    .update(credential, "utf8")
    .digest("hex");
}

function deviceCookieOptions() {
  const production = process.env.NODE_ENV === "production";

  return {
    httpOnly: true,
    secure: production,
    sameSite: production ? "none" : "lax",
    path: "/",
    maxAge: DEVICE_COOKIE_MAX_AGE
  };
}

function clearDeviceCookieOptions() {
  const production = process.env.NODE_ENV === "production";

  return {
    httpOnly: true,
    secure: production,
    sameSite: production ? "none" : "lax",
    path: "/"
  };
}

function setDeviceCookie(res, credential) {
  if (
    typeof credential !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(credential)
  ) {
    throw new TypeError("Invalid device credential.");
  }

  res.cookie(
    DEVICE_COOKIE_NAME,
    credential,
    deviceCookieOptions()
  );
}

function clearDeviceCookie(res) {
  res.clearCookie(
    DEVICE_COOKIE_NAME,
    clearDeviceCookieOptions()
  );
}

module.exports = {
  DEVICE_COOKIE_NAME,
  DEVICE_COOKIE_MAX_AGE,
  createDeviceCredential,
  hashDeviceCredential,
  deviceCookieOptions,
  clearDeviceCookieOptions,
  setDeviceCookie,
  clearDeviceCookie
};
