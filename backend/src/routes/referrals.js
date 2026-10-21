"use strict";

const express = require("express");
const User = require("../models/User");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

const MAX_LEVEL_SCAN = 5000;
const MAX_DISPLAY_PER_LEVEL = 50;

function getReferralLink(req, username) {
  const encodedUsername = encodeURIComponent(username);
  const isProduction = process.env.NODE_ENV === "production";

  // In development, generate links to the actual local registration page.
  if (!isProduction) {
    const allowedHosts = new Set(["localhost", "127.0.0.1"]);
    let localOrigin = "http://127.0.0.1:8080";
    const requestOrigin = req.get("origin");

    if (requestOrigin) {
      try {
        const parsedOrigin = new URL(requestOrigin);

        if (
          parsedOrigin.protocol === "http:" &&
          allowedHosts.has(parsedOrigin.hostname) &&
          parsedOrigin.port === "8080" &&
          !parsedOrigin.username &&
          !parsedOrigin.password
        ) {
          localOrigin = parsedOrigin.origin;
        }
      } catch {
        // Ignore invalid Origin headers and use the safe local fallback.
      }
    }

    return (
      `${localOrigin}/auth/register.html?ref=${encodedUsername}`
    );
  }

  // Production must explicitly configure its public frontend URL.
  const publicSiteUrl = process.env.PUBLIC_SITE_URL;

  if (!publicSiteUrl || !publicSiteUrl.trim()) {
    throw new Error("PUBLIC_SITE_URL must be configured in production.");
  }

  let parsedPublicUrl;

  try {
    parsedPublicUrl = new URL(publicSiteUrl);
  } catch {
    throw new Error("PUBLIC_SITE_URL is invalid.");
  }

  if (
    parsedPublicUrl.protocol !== "https:" ||
    parsedPublicUrl.username ||
    parsedPublicUrl.password ||
    parsedPublicUrl.search ||
    parsedPublicUrl.hash
  ) {
    throw new Error("PUBLIC_SITE_URL must be a valid HTTPS base URL.");
  }

  const baseUrl = publicSiteUrl.trim().replace(/\/+$/, "");
  return `${baseUrl}/register/${encodedUsername}`;
}

// GET /api/referrals/me
router.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select("_id username referredBy")
      .populate({
        path: "referredBy",
        select: "username firstName lastName status"
      });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Member account not found."
      });
    }

    const directReferrals = await User.countDocuments({
      referredBy: user._id
    });

    const sponsor = user.referredBy
      ? {
          username: user.referredBy.username,
          firstName: user.referredBy.firstName,
          lastName: user.referredBy.lastName,
          status: user.referredBy.status
        }
      : null;

    const referralLink = getReferralLink(req, user.username);

    return res.json({
      success: true,
      referral: {
        username: user.username,
        referralLink,
        sponsor,
        directReferrals
      }
    });
  } catch (error) {
    console.error("Referral summary error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load referral information."
    });
  }
});

// GET /api/referrals/network
// Returns the authenticated member's network through four levels.
router.get("/network", requireAuth, async (req, res) => {
  try {
    const levels = [];
    let parentIds = [req.user._id];
    let traversalLimited = false;

    for (let depth = 1; depth <= 4; depth += 1) {
      if (traversalLimited) {
        levels.push({
          level: depth,
          total: null,
          returned: 0,
          members: [],
          truncated: true,
          unavailable: true
        });
        continue;
      }

      if (parentIds.length === 0) {
        levels.push({
          level: depth,
          total: 0,
          returned: 0,
          members: [],
          truncated: false,
          unavailable: false
        });
        continue;
      }

      const filter = {
        referredBy: { $in: parentIds }
      };

      const [total, scannedMembers] = await Promise.all([
        User.countDocuments(filter),
        User.find(filter)
          .select("_id firstName lastName username status createdAt referredBy")
          .sort({ createdAt: -1, _id: -1 })
          .limit(MAX_LEVEL_SCAN + 1)
          .lean()
      ]);

      const scanLimitReached = total > MAX_LEVEL_SCAN;
      const members = scannedMembers
        .slice(0, MAX_DISPLAY_PER_LEVEL)
        .map((member) => ({
          id: member._id,
          firstName: member.firstName,
          lastName: member.lastName,
          username: member.username,
          status: member.status,
          joinedAt: member.createdAt
        }));

      levels.push({
        level: depth,
        total,
        returned: members.length,
        members,
        truncated: total > MAX_DISPLAY_PER_LEVEL,
        unavailable: false
      });

      // Avoid expanding an unexpectedly huge network in memory.
      // This level's count remains exact, but deeper levels cannot
      // be calculated completely if its parent list was capped.
      if (scanLimitReached) {
        traversalLimited = true;
        parentIds = [];
      } else {
        parentIds = scannedMembers.map((member) => member._id);
      }
    }

    const count = (depth) => {
      const entry = levels.find((item) => item.level === depth);
      return entry && entry.total !== null ? entry.total : null;
    };

    return res.json({
      success: true,
      network: {
        levels,
        counts: {
          level1: count(1),
          level2: count(2),
          level3: count(3),
          level4: count(4)
        },
        traversalLimited
      },
      message: traversalLimited
        ? "A level exceeded the network scan limit. Deeper levels are incomplete."
        : "Referral network loaded."
    });
  } catch (error) {
    console.error("Referral network error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load the referral network."
    });
  }
});

module.exports = router;
