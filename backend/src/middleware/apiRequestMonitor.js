"use strict";

const ApiRequestLog = require("../models/ApiRequestLog");

module.exports = function apiRequestMonitor(req, res, next) {
  if (
    !req.originalUrl.startsWith("/api/") ||
    req.method === "OPTIONS" ||
    req.path.startsWith("/api/admin/api-requests")
  ) {
    return next();
  }

  const startedAt = process.hrtime.bigint();

  res.once("finish", () => {
    const user = req.user || null;
    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6;

    const record = {
      userId: user?._id || null,
      username: user?.username || null,
      role: user?.role || "anonymous",
      ipAddress: req.ip || req.socket?.remoteAddress || null,
      method: req.method,
      path: String(req.originalUrl).split("?")[0].slice(0, 500),
      statusCode: res.statusCode,
      responseTimeMs: Math.round(elapsed * 100) / 100,
      userAgent: String(req.get("user-agent") || "").slice(0, 500)
    };

    ApiRequestLog.create(record).catch(error => {
      console.error("API request monitoring write failed:", error.message);
    });
  });

  next();
};
