"use strict";

const Membership = require("../models/Membership");

const ALLOWED_SERVICES = new Set([
  "transcription",
  "note-taking",
  "data-entry",
  "academic-writing"
]);

/*
 * Usage:
 * router.post("/protected-action", requireAuth,
 *   requireServiceAccess("transcription"), handler);
 *
 * This middleware checks the database, not browser-supplied permissions.
 */
function requireServiceAccess(service) {
  if (!ALLOWED_SERVICES.has(service)) {
    throw new Error("Invalid service name in requireServiceAccess.");
  }

  return async function serviceAccessMiddleware(req, res, next) {
    try {
      if (!req.user || !req.user._id) {
        return res.status(401).json({
          success: false,
          message: "Please sign in to continue."
        });
      }

      const now = new Date();

      const membership = await Membership.findOne({
        userId: req.user._id,
        status: "active",
        startsAt: { $lte: now },
        expiresAt: { $gt: now },
        services: service
      })
        .select("_id planKey expiresAt")
        .lean();

      if (!membership) {
        return res.status(403).json({
          success: false,
          code: "MEMBERSHIP_REQUIRED",
          service,
          message: "Your current membership does not grant access to this service."
        });
      }

      req.serviceMembership = membership;
      next();
    } catch (error) {
      console.error("Service access check error:", error.message);
      return res.status(500).json({
        success: false,
        message: "Could not verify service access."
      });
    }
  };
}

module.exports = requireServiceAccess;
