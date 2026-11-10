"use strict";

const mongoose = require("mongoose");

const Device = require("../models/Device");
const DeviceRegistration = require("../models/DeviceRegistration");
const DeviceTransferRequest = require("../models/DeviceTransferRequest");

const securityChain = require("./securityEventChainService");
const {
  DEVICE_COOKIE_NAME,
  createDeviceCredential,
  hashDeviceCredential,
  setDeviceCookie
} = require("./deviceCredentialService");

function requestMetadata(req) {
  return {
    ipAddress: req.ip || null,
    userAgent: String(req.get("user-agent") || "").slice(0, 1000) || null
  };
}

async function authorizeLoginDevice(req, res, user) {
  let credential = req.cookies?.[DEVICE_COOKIE_NAME] || null;
  let newCredential = false;

  if (!credential) {
    const generated = createDeviceCredential();
    credential = generated.credential;
    newCredential = true;
  }

  let credentialHash;

  try {
    credentialHash = hashDeviceCredential(credential);
  } catch {
    return {
      allowed: false,
      status: 401,
      code: "INVALID_DEVICE_CREDENTIAL",
      message: "This browser identity is invalid. Contact support for assistance."
    };
  }

  const metadata = requestMetadata(req);
  const now = new Date();

  const session = await mongoose.startSession();

  try {
    let result;

    await session.withTransaction(async () => {
      let device = await Device.findOne({
        deviceKeyHash: credentialHash
      })
        .select("+deviceKeyHash")
        .session(session);

      const activeRegistration = await DeviceRegistration.findOne({
        userId: user._id,
        status: "active"
      }).session(session);

      const previousRegistration = activeRegistration
        ? null
        : await DeviceRegistration.findOne({
            userId: user._id
          })
            .sort({ registeredAt: -1, _id: -1 })
            .session(session);

      const registrationForTransfer =
        activeRegistration || previousRegistration;

      if (device?.status === "banned") {
        await securityChain.recordSecurityEvent({
          eventType: "device_access_denied",
          severity: "critical",
          outcome: "denied",
          userId: user._id,
          deviceId: device._id,
          ...metadata,
          method: req.method,
          path: String(req.path || "").slice(0, 500),
          requestId: req.id || null,
          message: "Login rejected because the browser identity is banned."
        }, { session });

        result = {
          allowed: false,
          status: 403,
          code: "DEVICE_BANNED",
          message: "This browser is blocked from accessing PrimeTask Workspace."
        };
        return;
      }

      if (
        device &&
        activeRegistration &&
        activeRegistration.deviceId.equals(device._id)
      ) {
        await Device.updateOne(
          { _id: device._id },
          {
            $set: {
              lastSeenAt: now,
              lastKnownIp: metadata.ipAddress,
              lastUserAgent: metadata.userAgent
            }
          },
          { session }
        );

        await DeviceRegistration.updateOne(
          { _id: activeRegistration._id, status: "active" },
          { $set: { lastSeenAt: now } },
          { session }
        );

        result = { allowed: true, deviceId: device._id };
        return;
      }

      if (!device) {
        device = new Device({
          deviceKeyHash: credentialHash,
          status: "active",
          registeredAt: now,
          lastSeenAt: now,
          lastKnownIp: metadata.ipAddress,
          lastUserAgent: metadata.userAgent
        });

        await device.save({ session });
      }

      if (!registrationForTransfer) {
        const registration = new DeviceRegistration({
          userId: user._id,
          deviceId: device._id,
          status: "active",
          registeredAt: now,
          lastSeenAt: now
        });

        await registration.save({ session });

        await securityChain.recordSecurityEvent({
          eventType: "device_registered",
          severity: "info",
          outcome: "success",
          userId: user._id,
          deviceId: device._id,
          ...metadata,
          method: req.method,
          path: String(req.path || "").slice(0, 500),
          requestId: req.id || null,
          message: "First browser identity registered to account."
        }, { session });

        result = { allowed: true, deviceId: device._id };
        return;
      }

      const pendingRequest = await DeviceTransferRequest.findOne({
        userId: user._id,
        status: "pending"
      }).session(session);

      if (pendingRequest) {
        if (pendingRequest.proposedDeviceId.equals(device._id)) {
          pendingRequest.requestCount += 1;
          pendingRequest.failedAttempts += 1;
          pendingRequest.lastRequestedAt = now;
          pendingRequest.lastAttemptAt = now;
          pendingRequest.requestIp = metadata.ipAddress;
          pendingRequest.requestUserAgent = metadata.userAgent;

          await pendingRequest.save({ session });

          await securityChain.recordSecurityEvent({
            eventType: "device_transfer_failed",
            severity: "warning",
            outcome: "denied",
            userId: user._id,
            deviceId: device._id,
            ...metadata,
            method: req.method,
            path: String(req.path || "").slice(0, 500),
            requestId: req.id || null,
            message: "Login blocked while browser transfer awaits administrator review."
          }, { session });
        } else {
          await securityChain.recordSecurityEvent({
            eventType: "device_access_denied",
            severity: "warning",
            outcome: "denied",
            userId: user._id,
            deviceId: device._id,
            ...metadata,
            method: req.method,
            path: String(req.path || "").slice(0, 500),
            requestId: req.id || null,
            message: "Another browser attempted access while a device transfer was already pending."
          }, { session });
        }

        result = {
          allowed: false,
          status: 403,
          code: "DEVICE_TRANSFER_PENDING",
          message: "This account is registered to another browser. Your device transfer is awaiting administrator review."
        };
        return;
      }

      const transferRequest = new DeviceTransferRequest({
        userId: user._id,
        oldRegistrationId: registrationForTransfer._id,
        oldDeviceId: registrationForTransfer.deviceId,
        proposedDeviceId: device._id,
        status: "pending",
        requestIp: metadata.ipAddress,
        requestUserAgent: metadata.userAgent,
        requestCount: 1,
        failedAttempts: 1,
        firstRequestedAt: now,
        lastRequestedAt: now,
        lastAttemptAt: now
      });

      await transferRequest.save({ session });

      await securityChain.recordSecurityEvent({
        eventType: "device_transfer_requested",
        severity: "warning",
        outcome: "pending",
        userId: user._id,
        deviceId: device._id,
        ...metadata,
        method: req.method,
        path: String(req.path || "").slice(0, 500),
        requestId: req.id || null,
        message: "New browser blocked pending administrator device-transfer review."
      }, { session });

      result = {
        allowed: false,
        status: 403,
        code: "DEVICE_TRANSFER_PENDING",
        message: "This account is registered to another browser. Your device transfer is awaiting administrator review."
      };
    });

    if (newCredential) {
      setDeviceCookie(res, credential);
    }

    return result;
  } finally {
    await session.endSession();
  }
}



async function authorizeRequestDevice(req, user) {
  const credential = req.cookies?.[DEVICE_COOKIE_NAME];

  if (!credential) {
    return {
      allowed: false,
      status: 401,
      code: "DEVICE_CREDENTIAL_MISSING",
      message: "This browser is not registered to your account."
    };
  }

  let credentialHash;

  try {
    credentialHash = hashDeviceCredential(credential);
  } catch {
    return {
      allowed: false,
      status: 401,
      code: "INVALID_DEVICE_CREDENTIAL",
      message: "This browser identity is invalid. Please sign in again."
    };
  }

  const metadata = requestMetadata(req);
  const now = new Date();

  let session;

  try {
    session = await mongoose.startSession();

    let result;

    await session.withTransaction(async () => {
      const device = await Device.findOne({
        deviceKeyHash: credentialHash
      }).session(session);

      if (!device) {
        result = {
          allowed: false,
          status: 401,
          code: "DEVICE_NOT_REGISTERED",
          message: "This browser is not registered to your account."
        };
        return;
      }

      if (device.status === "banned") {
        await securityChain.recordSecurityEvent({
          eventType: "device_access_denied",
          severity: "critical",
          outcome: "denied",
          userId: user._id,
          deviceId: device._id,
          ...metadata,
          method: req.method,
          path: String(req.path || "").slice(0, 500),
          requestId: req.id || null,
          message: "Protected request rejected because the browser identity is banned."
        }, { session });

        result = {
          allowed: false,
          status: 403,
          code: "DEVICE_BANNED",
          message: "This browser is blocked from accessing PrimeTask Workspace."
        };
        return;
      }

      const registration = await DeviceRegistration.findOne({
        userId: user._id,
        deviceId: device._id,
        status: "active"
      }).session(session);

      if (!registration) {
        await securityChain.recordSecurityEvent({
          eventType: "device_access_denied",
          severity: "warning",
          outcome: "denied",
          userId: user._id,
          deviceId: device._id,
          ...metadata,
          method: req.method,
          path: String(req.path || "").slice(0, 500),
          requestId: req.id || null,
          message: "Protected request rejected because this browser has no active account registration."
        }, { session });

        result = {
          allowed: false,
          status: 403,
          code: "DEVICE_NOT_AUTHORIZED",
          message: "This browser is not authorized for this account."
        };
        return;
      }

      // Write to the registration as well as the device. This makes
      // authorization contend with both global bans and account-specific
      // registration revocations.
      const registrationUpdate = await DeviceRegistration.updateOne(
        {
          _id: registration._id,
          userId: user._id,
          deviceId: device._id,
          status: "active"
        },
        {
          $set: { lastSeenAt: now }
        },
        { session }
      );

      if (registrationUpdate.matchedCount !== 1) {
        await securityChain.recordSecurityEvent({
          eventType: "device_access_denied",
          severity: "warning",
          outcome: "denied",
          userId: user._id,
          deviceId: device._id,
          ...metadata,
          method: req.method,
          path: String(req.path || "").slice(0, 500),
          requestId: req.id || null,
          message: "Protected request rejected because the account registration changed during authorization."
        }, { session });

        result = {
          allowed: false,
          status: 403,
          code: "DEVICE_NOT_AUTHORIZED",
          message: "This browser is not authorized for this account."
        };
        return;
      }

      // This conditional write must match an active device. A concurrent
      // global ban updates this same document and causes transaction
      // conflict/retry instead of allowing a stale authorization.
      const deviceUpdate = await Device.updateOne(
        {
          _id: device._id,
          status: "active"
        },
        {
          $set: {
            lastSeenAt: now,
            lastKnownIp: metadata.ipAddress,
            lastUserAgent: metadata.userAgent
          }
        },
        { session }
      );

      if (deviceUpdate.matchedCount !== 1) {
        await securityChain.recordSecurityEvent({
          eventType: "device_access_denied",
          severity: "critical",
          outcome: "denied",
          userId: user._id,
          deviceId: device._id,
          ...metadata,
          method: req.method,
          path: String(req.path || "").slice(0, 500),
          requestId: req.id || null,
          message: "Protected request rejected because the browser identity is no longer active."
        }, { session });

        result = {
          allowed: false,
          status: 403,
          code: "DEVICE_BANNED",
          message: "This browser is blocked from accessing PrimeTask Workspace."
        };
        return;
      }

      result = {
        allowed: true,
        deviceId: device._id
      };
    });

    return result;
  } finally {
    if (session) {
      try {
        await session.endSession();
      } catch (error) {
        console.error("Device authorization session cleanup failed:", error.message);
      }
    }
  }
}


module.exports = {
  authorizeLoginDevice,
  authorizeRequestDevice
};
