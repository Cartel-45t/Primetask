"use strict";

const express = require("express");
const mongoose = require("mongoose");
const net = require("node:net");

const requireAuth = require("../middleware/requireAuth");
const securityChain = require("../services/securityEventChainService");

const Device = require("../models/Device");
const DeviceRegistration = require("../models/DeviceRegistration");
const DeviceTransferRequest = require("../models/DeviceTransferRequest");
const User = require("../models/User");
const SecurityEvent = require("../models/SecurityEvent");

const router = express.Router();

router.use(requireAuth);

router.use((req, res, next) => {
  if (!["admin", "founder"].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: "Administrator access is required."
    });
  }

  next();
});

function reviewError(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

function requestMetadata(req) {
  return {
    ipAddress: req.ip || null,
    userAgent: String(req.get("user-agent") || "").slice(0, 1000),
    method: req.method,
    path: String(req.originalUrl || req.path || "").slice(0, 500),
    requestId: req.id || null
  };
}

function validateReason(value, maxLength = 1000) {
  if (typeof value !== "string") return null;

  const reason = value.trim();

  if (reason.length < 5 || reason.length > maxLength) {
    return null;
  }

  return reason;
}

router.get("/chain/verify", async (req, res) => {
  try {
    const result = await securityChain.verifySecurityEventChain();

    const data = {
      valid: result.valid === true,
      status: result.status,
      checkedEvents: Number(result.checkedEvents || 0)
    };

    if (result.reason) data.reason = result.reason;
    if (Number.isInteger(result.sequence)) {
      data.sequence = result.sequence;
    }

    return res.status(result.valid ? 200 : 409).json({
      success: result.valid === true,
      data
    });
  } catch (error) {
    console.error(
      "Admin security chain verification failed:",
      error.message
    );

    return res.status(503).json({
      success: false,
      message: "Security chain verification is temporarily unavailable."
    });
  }
});

// Return pending transfer requests without exposing device credentials.
router.get("/devices/transfers", async (req, res) => {
  try {
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 100)
      : 50;

    const requests = await DeviceTransferRequest.find({
      status: "pending"
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .populate("userId", "firstName lastName username email role status")
      .populate("oldDeviceId", "status deviceLabel manufacturer deviceModel platform osVersion browser browserVersion deviceType registeredAt lastSeenAt lastKnownIp lastUserAgent")
      .populate("proposedDeviceId", "status deviceLabel manufacturer deviceModel platform osVersion browser browserVersion deviceType registeredAt lastSeenAt lastKnownIp lastUserAgent")
      .lean();

    return res.json({
      success: true,
      data: {
        requests
      }
    });
  } catch (error) {
    console.error("Pending device transfer lookup failed:", error.message);

    return res.status(503).json({
      success: false,
      message: "Device transfer requests are temporarily unavailable."
    });
  }
});

router.patch("/devices/transfers/:requestId/ip-reference", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.requestId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid transfer request ID."
    });
  }

  if (typeof req.body?.ipReference !== "string") {
    return res.status(400).json({
      success: false,
      message: "Provide an IPv4 or IPv6 address. Send an empty string to clear the reference."
    });
  }

  const ipReference = req.body.ipReference.trim();
  const reason = validateReason(req.body?.reason, 500);

  if (ipReference.length > 100 || (ipReference && net.isIP(ipReference) === 0)) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid IPv4 or IPv6 address, up to 100 characters."
    });
  }

  if (!reason) {
    return res.status(400).json({
      success: false,
      message: "Provide an update reason between 5 and 500 characters."
    });
  }

  let session;

  try {
    session = await mongoose.startSession();

    let updated;

    await session.withTransaction(async () => {
      const transfer = await DeviceTransferRequest.findById(
        req.params.requestId
      ).session(session);

      if (!transfer) {
        throw reviewError(404, "Transfer request was not found.");
      }

      if (transfer.status !== "pending") {
        throw reviewError(409, "Only pending transfer requests can be edited.");
      }

      const now = new Date();

      transfer.adminIpReference = ipReference || null;
      transfer.ipReferenceUpdatedAt = now;
      transfer.ipReferenceUpdatedByAdminId = req.user._id;
      transfer.ipReferenceReason = reason;

      await transfer.save({ session });

      await securityChain.recordSecurityEvent({
        eventType: "device_transfer_ip_reference_updated",
        severity: "warning",
        outcome: "success",
        userId: transfer.userId,
        actorUserId: req.user._id,
        targetUserId: transfer.userId,
        deviceId: transfer.proposedDeviceId,
        ...requestMetadata(req),
        message: `Administrator ${ipReference ? "updated" : "cleared"} the IP reference for a pending browser transfer. Reason: ${reason}`
      }, { session });

      updated = {
        requestId: transfer._id,
        adminIpReference: transfer.adminIpReference,
        updatedAt: now,
        updatedByAdminId: req.user._id
      };
    });

    return res.json({
      success: true,
      message: "IP reference saved. It does not authorize the browser transfer.",
      data: updated
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }

    console.error("Transfer IP reference update failed:", error.message);

    return res.status(503).json({
      success: false,
      message: "The IP reference could not be saved."
    });
  } finally {
    if (session) {
      try {
        await session.endSession();
      } catch (cleanupError) {
        console.error(
          "IP reference session cleanup failed:",
          cleanupError.message
        );
      }
    }
  }
});

router.post("/devices/transfers/:requestId/approve", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.requestId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid transfer request ID."
    });
  }

  const reason = validateReason(req.body?.reason);

  if (!reason) {
    return res.status(400).json({
      success: false,
      message: "Provide an approval reason between 5 and 1000 characters."
    });
  }

  let session;

  try {
    session = await mongoose.startSession();

    let approved;

    await session.withTransaction(async () => {
      const transfer = await DeviceTransferRequest.findById(
        req.params.requestId
      ).session(session);

      if (!transfer) {
        throw reviewError(404, "Transfer request was not found.");
      }

      if (transfer.status !== "pending") {
        throw reviewError(409, "This transfer request is no longer pending.");
      }

      const account = await User.findById(transfer.userId)
        .select("_id status")
        .session(session);

      if (!account || account.status !== "active") {
        throw reviewError(409, "The account is missing or inactive.");
      }

      const oldRegistration = await DeviceRegistration.findById(
        transfer.oldRegistrationId
      ).session(session);

      const proposedDevice = await Device.findById(
        transfer.proposedDeviceId
      ).session(session);

      if (
        !oldRegistration ||
        oldRegistration.userId.toString() !== transfer.userId.toString() ||
        oldRegistration.deviceId.toString() !== transfer.oldDeviceId.toString()
      ) {
        throw reviewError(
          409,
          "The original device registration no longer matches this request."
        );
      }

      if (!proposedDevice || proposedDevice.status !== "active") {
        throw reviewError(
          409,
          "The proposed browser is unavailable or banned."
        );
      }

      const activeRegistration = await DeviceRegistration.findOne({
        userId: transfer.userId,
        status: "active"
      }).session(session);

      if (activeRegistration) {
        if (
          activeRegistration._id.toString() !== oldRegistration._id.toString() ||
          oldRegistration.status !== "active"
        ) {
          throw reviewError(
            409,
            "The account's active device changed. Review the request again."
          );
        }

        const revokeResult = await DeviceRegistration.updateOne(
          {
            _id: oldRegistration._id,
            userId: transfer.userId,
            deviceId: transfer.oldDeviceId,
            status: "active"
          },
          {
            $set: {
              status: "revoked",
              revokedAt: new Date(),
              revokedReason: `Device transfer approved: ${reason}`,
              reviewedByAdminId: req.user._id
            }
          },
          { session }
        );

        if (revokeResult.modifiedCount !== 1) {
          throw reviewError(
            409,
            "The original device registration changed during review."
          );
        }
      } else if (oldRegistration.status !== "revoked") {
        throw reviewError(
          409,
          "The original registration is not in an expected state."
        );
      }

      const now = new Date();

      const newRegistration = new DeviceRegistration({
        userId: transfer.userId,
        deviceId: transfer.proposedDeviceId,
        status: "active",
        registeredAt: now,
        lastSeenAt: now,
        reviewedByAdminId: req.user._id
      });

      await newRegistration.save({ session });

      transfer.status = "approved";
      transfer.reviewedByAdminId = req.user._id;
      transfer.reviewedAt = now;
      transfer.reviewReason = reason;
      transfer.approvedAt = now;

      await transfer.save({ session });

      await securityChain.recordSecurityEvent({
        eventType: "device_transfer_completed",
        severity: "warning",
        outcome: "success",
        userId: transfer.userId,
        actorUserId: req.user._id,
        targetUserId: transfer.userId,
        deviceId: transfer.proposedDeviceId,
        ...requestMetadata(req),
        message: `Administrator approved a browser transfer. Reason: ${reason}`
      }, { session });

      approved = {
        requestId: transfer._id,
        userId: transfer.userId,
        oldDeviceId: transfer.oldDeviceId,
        newDeviceId: transfer.proposedDeviceId,
        registrationId: newRegistration._id,
        reviewedAt: now
      };
    });

    return res.json({
      success: true,
      message: "Device transfer approved.",
      data: approved
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }

    console.error("Device transfer approval failed:", error.message);

    return res.status(503).json({
      success: false,
      message: "Device transfer approval could not be completed."
    });
  } finally {
    if (session) {
      try {
        await session.endSession();
      } catch (cleanupError) {
        console.error(
          "Device transfer session cleanup failed:",
          cleanupError.message
        );
      }
    }
  }
});

router.post("/devices/transfers/:requestId/reject", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.requestId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid transfer request ID."
    });
  }

  const reason = validateReason(req.body?.reason);

  if (!reason) {
    return res.status(400).json({
      success: false,
      message: "Provide a rejection reason between 5 and 1000 characters."
    });
  }

  let session;

  try {
    session = await mongoose.startSession();

    let rejected;

    await session.withTransaction(async () => {
      const transfer = await DeviceTransferRequest.findById(
        req.params.requestId
      ).session(session);

      if (!transfer) {
        throw reviewError(404, "Transfer request was not found.");
      }

      if (transfer.status !== "pending") {
        throw reviewError(409, "This transfer request is no longer pending.");
      }

      const now = new Date();

      transfer.status = "rejected";
      transfer.reviewedByAdminId = req.user._id;
      transfer.reviewedAt = now;
      transfer.reviewReason = reason;
      transfer.rejectedAt = now;

      await transfer.save({ session });

      await securityChain.recordSecurityEvent({
        eventType: "device_transfer_rejected",
        severity: "warning",
        outcome: "denied",
        userId: transfer.userId,
        actorUserId: req.user._id,
        targetUserId: transfer.userId,
        deviceId: transfer.proposedDeviceId,
        ...requestMetadata(req),
        message: `Administrator rejected a browser transfer. Reason: ${reason}`
      }, { session });

      rejected = {
        requestId: transfer._id,
        userId: transfer.userId,
        reviewedAt: now
      };
    });

    return res.json({
      success: true,
      message: "Device transfer rejected.",
      data: rejected
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }

    console.error("Device transfer rejection failed:", error.message);

    return res.status(503).json({
      success: false,
      message: "Device transfer rejection could not be completed."
    });
  } finally {
    if (session) {
      try {
        await session.endSession();
      } catch (cleanupError) {
        console.error(
          "Device transfer session cleanup failed:",
          cleanupError.message
        );
      }
    }
  }
});


// Safe global device inventory. Never expose device credentials.
router.get("/devices", async (req, res) => {
  try {
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 100)
      : 50;

    const devices = await Device.find({})
      .select("status deviceLabel manufacturer deviceModel platform osVersion browser browserVersion deviceType registeredAt lastSeenAt lastKnownIp lastUserAgent bannedAt banReason reviewedByAdminId")
      .sort({ lastSeenAt: -1, _id: -1 })
      .limit(limit)
      .populate("reviewedByAdminId", "firstName lastName username")
      .lean();

    return res.json({ success: true, data: { devices } });
  } catch (error) {
    console.error("Admin device inventory lookup failed:", error.message);
    return res.status(503).json({
      success: false,
      message: "Device inventory is temporarily unavailable."
    });
  }
});

// Global ban: revoke registrations and cancel transfers targeting this device.
router.post("/devices/:deviceId/ban", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.deviceId)) {
    return res.status(400).json({ success: false, message: "Invalid device ID." });
  }

  const reason = validateReason(req.body?.reason, 500);
  if (!reason) {
    return res.status(400).json({
      success: false,
      message: "Provide a ban reason between 5 and 500 characters."
    });
  }

  let session;
  try {
    session = await mongoose.startSession();
    let result;

    await session.withTransaction(async () => {
      const device = await Device.findById(req.params.deviceId).session(session);
      if (!device) throw reviewError(404, "Device was not found.");
      if (device.status !== "active") {
        throw reviewError(409, "This device is already banned.");
      }

      const now = new Date();
      const banResult = await Device.updateOne(
        { _id: device._id, status: "active" },
        { $set: {
          status: "banned",
          bannedAt: now,
          banReason: reason,
          reviewedByAdminId: req.user._id
        } },
        { session }
      );

      if (banResult.modifiedCount !== 1) {
        throw reviewError(409, "Device status changed during review.");
      }

      const registrations = await DeviceRegistration.updateMany(
        { deviceId: device._id, status: "active" },
        { $set: {
          status: "revoked",
          revokedAt: now,
          revokedReason: `Global device ban: ${reason}`.slice(0, 500),
          reviewedByAdminId: req.user._id
        } },
        { session }
      );

      const transfers = await DeviceTransferRequest.updateMany(
        { proposedDeviceId: device._id, status: "pending" },
        { $set: {
          status: "cancelled",
          cancelledAt: now,
          reviewedByAdminId: req.user._id,
          reviewedAt: now,
          reviewReason: `Proposed device globally banned: ${reason}`.slice(0, 1000)
        } },
        { session }
      );

      const revokedRegistrationCount = registrations.modifiedCount || 0;
      const cancelledTransferCount = transfers.modifiedCount || 0;

      await securityChain.recordSecurityEvent({
        eventType: "device_banned",
        severity: "critical",
        outcome: "success",
        actorUserId: req.user._id,
        deviceId: device._id,
        ...requestMetadata(req),
        message: `Global browser ban; revoked ${revokedRegistrationCount} registration(s), cancelled ${cancelledTransferCount} transfer(s). Reason: ${reason}`
      }, { session });

      result = {
        deviceId: device._id,
        status: "banned",
        bannedAt: now,
        revokedRegistrationCount,
        cancelledTransferCount
      };
    });

    return res.json({
      success: true,
      message: "Device globally banned. All active registrations were revoked.",
      data: result
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }
    console.error("Global device ban failed:", error.message);
    return res.status(503).json({
      success: false,
      message: "Device ban failed. No partial changes were committed."
    });
  } finally {
    if (session) {
      try { await session.endSession(); }
      catch (error) {
        console.error("Device ban session cleanup failed:", error.message);
      }
    }
  }
});

// Unban the device identity only. Previous registrations stay revoked.
router.post("/devices/:deviceId/unban", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.deviceId)) {
    return res.status(400).json({ success: false, message: "Invalid device ID." });
  }

  const reason = validateReason(req.body?.reason, 500);
  if (!reason) {
    return res.status(400).json({
      success: false,
      message: "Provide an unban reason between 5 and 500 characters."
    });
  }

  let session;
  try {
    session = await mongoose.startSession();
    let result;

    await session.withTransaction(async () => {
      const device = await Device.findById(req.params.deviceId).session(session);
      if (!device) throw reviewError(404, "Device was not found.");
      if (device.status !== "banned") {
        throw reviewError(409, "This device is not currently banned.");
      }

      const now = new Date();
      const update = await Device.updateOne(
        { _id: device._id, status: "banned" },
        { $set: {
          status: "active",
          bannedAt: null,
          banReason: null,
          reviewedByAdminId: req.user._id
        } },
        { session }
      );

      if (update.modifiedCount !== 1) {
        throw reviewError(409, "Device status changed during review.");
      }

      await securityChain.recordSecurityEvent({
        eventType: "device_unbanned",
        severity: "warning",
        outcome: "success",
        actorUserId: req.user._id,
        deviceId: device._id,
        ...requestMetadata(req),
        message: `Device unbanned; previous registrations remain revoked. Reason: ${reason}`
      }, { session });

      result = {
        deviceId: device._id,
        status: "active",
        unbannedAt: now,
        registrationsRestored: false
      };
    });

    return res.json({
      success: true,
      message: "Device unbanned. Previous registrations remain revoked.",
      data: result
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }
    console.error("Global device unban failed:", error.message);
    return res.status(503).json({
      success: false,
      message: "Device unban failed. No partial changes were committed."
    });
  } finally {
    if (session) {
      try { await session.endSession(); }
      catch (error) {
        console.error("Device unban session cleanup failed:", error.message);
      }
    }
  }
});


const AUTH_EVENT_TYPES = [
  "login_success",
  "login_failed",
  "logout",
  "session_revoked",
  "password_reset_requested",
  "password_reset_completed"
];

router.get("/authentication-events", async (req, res) => {
  try {
    const parsedPage = Number.parseInt(req.query.page, 10);
    const parsedLimit = Number.parseInt(req.query.limit, 10);

    const page = Number.isInteger(parsedPage) && parsedPage > 0
      ? parsedPage
      : 1;

    const limit = Number.isInteger(parsedLimit)
      ? Math.min(100, Math.max(1, parsedLimit))
      : 50;

    const baseMatch = {
      eventType: { $in: AUTH_EVENT_TYPES }
    };

    if (req.query.outcome && ["success", "denied", "failed", "pending"].includes(req.query.outcome)) {
      baseMatch.outcome = req.query.outcome;
    }

    if (req.query.ip) {
      baseMatch.ipAddress = String(req.query.ip).trim().slice(0, 100);
    }

    if (req.query.userId && mongoose.isValidObjectId(req.query.userId)) {
      baseMatch.userId = new mongoose.Types.ObjectId(req.query.userId);
    }

    if (req.query.since) {
      const since = new Date(req.query.since);
      if (!Number.isNaN(since.getTime())) {
        baseMatch.createdAt = { ...(baseMatch.createdAt || {}), $gte: since };
      }
    }

    if (req.query.until) {
      const until = new Date(req.query.until);
      if (!Number.isNaN(until.getTime())) {
        baseMatch.createdAt = { ...(baseMatch.createdAt || {}), $lte: until };
      }
    }

    if (req.query.q) {
      const escaped = String(req.query.q)
        .trim()
        .slice(0, 100)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      if (escaped) {
        const search = new RegExp(escaped, "i");
        baseMatch.$or = [
          { message: search },
          { path: search },
          { ipAddress: search }
        ];
      }
    }

    const listMatch = { ...baseMatch };

    if (
      req.query.eventType &&
      AUTH_EVENT_TYPES.includes(String(req.query.eventType))
    ) {
      listMatch.eventType = req.query.eventType;
    }

    const [
      total,
      successful,
      denied,
      failed,
      uniqueIPs,
      uniqueAccounts,
      events
    ] = await Promise.all([
      SecurityEvent.countDocuments(baseMatch),
      SecurityEvent.countDocuments({ ...baseMatch, outcome: "success" }),
      SecurityEvent.countDocuments({ ...baseMatch, outcome: "denied" }),
      SecurityEvent.countDocuments({ ...baseMatch, outcome: "failed" }),
      SecurityEvent.distinct("ipAddress", {
        ...baseMatch,
        ipAddress: { ...((baseMatch.ipAddress && typeof baseMatch.ipAddress === "object") ? baseMatch.ipAddress : {}), $nin: [null, ""] }
      }),
      SecurityEvent.distinct("userId", {
        ...baseMatch,
        userId: { $ne: null }
      }),
      SecurityEvent.find(listMatch)
        .select(
          "eventType severity outcome userId ipAddress countryCode region city userAgent method path statusCode durationMs requestId message sequence createdAt"
        )
        .populate("userId", "username email role")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
    ]);

    return res.json({
      success: true,
      data: {
        summary: {
          total,
          successful,
          denied,
          failed,
          uniqueIPs: uniqueIPs.length,
          uniqueAccounts: uniqueAccounts.length
        },
        events,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error("Authentication event monitor failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Authentication events could not be loaded."
    });
  }
});


router.get("/rate-limit-events", async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));

    const filter = { eventType: "rate_limit_triggered" };

    if (req.query.ip) {
      filter.ipAddress = String(req.query.ip).trim().slice(0, 100);
    }

    const [total, uniqueIPs, events] = await Promise.all([
      SecurityEvent.countDocuments(filter),
      SecurityEvent.distinct("ipAddress", {
        ...filter,
        ipAddress: { $nin: [null, ""] }
      }),
      SecurityEvent.find(filter)
        .select("eventType severity outcome userId ipAddress userAgent method path statusCode message createdAt")
        .populate("userId", "username email role")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
    ]);

    return res.json({
      success: true,
      data: {
        summary: { total, uniqueIPs: uniqueIPs.length },
        events,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error("Rate-limit event monitor failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Rate-limit events could not be loaded."
    });
  }
});

module.exports = router;
