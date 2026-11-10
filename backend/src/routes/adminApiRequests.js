"use strict";

const express = require("express");
const mongoose = require("mongoose");

const requireAuth = require("../middleware/requireAuth");
const ApiRequestLog = require("../models/ApiRequestLog");

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

function dateFilter(query) {
  const filter = {};

  if (query.since) {
    const since = new Date(query.since);
    if (!Number.isNaN(since.getTime())) {
      filter.$gte = since;
    }
  }

  if (query.until) {
    const until = new Date(query.until);
    if (!Number.isNaN(until.getTime())) {
      filter.$lte = until;
    }
  }

  return Object.keys(filter).length ? filter : null;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

router.get("/overview", async (req, res) => {
  try {
    const dates = dateFilter(req.query);
    const match = dates ? { createdAt: dates } : {};

    const [
      totalRequests,
      failedRequests,
      serverErrors,
      successfulRequests,
      uniqueUsers,
      uniqueIps,
      uniqueEndpoints,
      responseStats,
      topEndpoints,
      topUsers,
      topIps,
      recentRequests
    ] = await Promise.all([
      ApiRequestLog.countDocuments(match),
      ApiRequestLog.countDocuments({
        ...match,
        statusCode: { $gte: 400 }
      }),
      ApiRequestLog.countDocuments({
        ...match,
        statusCode: { $gte: 500 }
      }),
      ApiRequestLog.countDocuments({
        ...match,
        statusCode: { $gte: 200, $lt: 400 }
      }),
      ApiRequestLog.distinct("userId", {
        ...match,
        userId: { $ne: null }
      }),
      ApiRequestLog.distinct("ipAddress", {
        ...match,
        ipAddress: { $nin: [null, ""] }
      }),
      ApiRequestLog.distinct("path", match),
      ApiRequestLog.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            averageResponseTimeMs: { $avg: "$responseTimeMs" },
            slowestResponseMs: { $max: "$responseTimeMs" }
          }
        }
      ]),
      ApiRequestLog.aggregate([
        { $match: match },
        {
          $group: {
            _id: { method: "$method", path: "$path" },
            requests: { $sum: 1 },
            failures: {
              $sum: { $cond: [{ $gte: ["$statusCode", 400] }, 1, 0] }
            },
            averageResponseTimeMs: { $avg: "$responseTimeMs" }
          }
        },
        { $sort: { requests: -1 } },
        { $limit: 15 }
      ]),
      ApiRequestLog.aggregate([
        {
          $match: {
            ...match,
            userId: { $ne: null }
          }
        },
        {
          $group: {
            _id: "$userId",
            username: { $first: "$username" },
            role: { $first: "$role" },
            requests: { $sum: 1 }
          }
        },
        { $sort: { requests: -1 } },
        { $limit: 15 }
      ]),
      ApiRequestLog.aggregate([
        {
          $match: {
            ...match,
            ipAddress: { $nin: [null, ""] }
          }
        },
        {
          $group: {
            _id: "$ipAddress",
            requests: { $sum: 1 }
          }
        },
        { $sort: { requests: -1 } },
        { $limit: 15 }
      ]),
      ApiRequestLog.find(match)
        .sort({ createdAt: -1 })
        .limit(20)
        .lean()
    ]);

    const average = Number(
      responseStats[0]?.averageResponseTimeMs || 0
    );

    res.json({
      success: true,
      data: {
        totalRequests,
        failedRequests,
        serverErrors,
        successfulRequests,
        uniqueEndpoints: uniqueEndpoints.length,
        uniqueUsers: uniqueUsers.length,
        uniqueIps: uniqueIps.length,
        averageResponseTimeMs: Math.round(average * 100) / 100,
        slowestResponseMs: responseStats[0]?.slowestResponseMs || 0,
        topEndpoints,
        topUsers,
        topIps,
        recentRequests
      }
    });
  } catch (error) {
    console.error("API request overview failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to load API request statistics."
    });
  }
});

router.get("/logs", async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 25)
    );

    const filter = {};
    const dates = dateFilter(req.query);

    if (dates) filter.createdAt = dates;

    if (req.query.method) {
      filter.method = String(req.query.method).toUpperCase().slice(0, 10);
    }

    if (req.query.statusClass === "4xx") {
      filter.statusCode = { $gte: 400, $lt: 500 };
    } else if (req.query.statusClass === "5xx") {
      filter.statusCode = { $gte: 500, $lt: 600 };
    } else if (req.query.statusClass === "errors") {
      filter.statusCode = { $gte: 400, $lt: 600 };
    } else if (req.query.status) {
      const status = Number.parseInt(req.query.status, 10);
      if (Number.isInteger(status) && status >= 100 && status <= 599) {
        filter.statusCode = status;
      }
    }

    if (req.query.userId && mongoose.isValidObjectId(req.query.userId)) {
      filter.userId = req.query.userId;
    }

    if (req.query.ip) {
      filter.ipAddress = String(req.query.ip).slice(0, 100);
    }

    if (req.query.q) {
      const search = new RegExp(
        escapeRegex(String(req.query.q).slice(0, 100)),
        "i"
      );

      filter.$or = [
        { path: search },
        { username: search },
        { ipAddress: search }
      ];
    }

    const [total, logs] = await Promise.all([
      ApiRequestLog.countDocuments(filter),
      ApiRequestLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
    ]);

    res.json({
      success: true,
      data: {
        logs,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error("API request history failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to load API request history."
    });
  }
});

module.exports = router;
