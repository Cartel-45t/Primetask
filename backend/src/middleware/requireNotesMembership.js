"use strict";

const Membership = require("../models/Membership");

const PRIVILEGED_ROLES = new Set(["admin", "founder"]);

module.exports = async function requireNotesMembership(req, res, next) {
  try {
    const role = String(req.user?.role || "").toLowerCase();

    if (PRIVILEGED_ROLES.has(role)) {
      return next();
    }

    const now = new Date();

    const membership = await Membership.findOne({
      userId: req.user._id,
      status: "active",
      services: "note-taking",
      startsAt: { $lte: now },
      expiresAt: { $gt: now }
    })
      .select("_id")
      .lean();

    if (!membership) {
      return res.status(403).json({
        success: false,
        code: "MEMBERSHIP_REQUIRED",
        message:
          "An active PrimeTask Notes membership is required to access Notes Points and claim tasks."
      });
    }

    return next();
  } catch (error) {
    console.error("Notes membership check failed:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to verify your Notes membership."
    });
  }
};
