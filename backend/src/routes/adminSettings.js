"use strict";

const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const PlatformSetting = require("../models/PlatformSetting");
const AdminAuditLog = require("../models/AdminAuditLog");

const router = express.Router();

router.use(requireAuth);
router.use((req, res, next) => {
  if (!["admin", "founder"].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: "Administrator access is required." });
  }
  next();
});

function publicSettings(doc) {
  return {
    registrationEnabled: doc.registrationEnabled,
    maintenanceMode: doc.maintenanceMode,
    exchangeRateKesPerUsd: Number.isFinite(doc.exchangeRateKesPerUsd)
      ? doc.exchangeRateKesPerUsd
      : null,
    updatedAt: doc.updatedAt || null
  };
}

async function getOrCreateSettings() {
  return PlatformSetting.findOneAndUpdate(
    { key: "platform" },
    { $setOnInsert: { key: "platform" } },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  );
}

router.get("/", async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    return res.json({ success: true, data: publicSettings(settings) });
  } catch (error) {
    console.error("Admin settings read failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not load platform settings." });
  }
});

router.put("/", async (req, res) => {
  try {
    const body = req.body || {};
    const allowed = [
      "registrationEnabled",
      "maintenanceMode",
      "exchangeRateKesPerUsd"
    ];
    const keys = Object.keys(body);

    if (!keys.length || keys.some(key => !allowed.includes(key))) {
      return res.status(400).json({
        success: false,
        message: "Only registrationEnabled, maintenanceMode, and exchangeRateKesPerUsd can be updated."
      });
    }

    for (const key of keys) {
      if (key === "exchangeRateKesPerUsd") {
        const rate = body[key];
        if (
          typeof rate !== "number" ||
          !Number.isFinite(rate) ||
          rate < 1 ||
          rate > 1000 ||
          Math.round(rate * 10000) !== rate * 10000
        ) {
          return res.status(400).json({
            success: false,
            message: "Exchange rate must be a number from 1 to 1000 KES per USD, with at most four decimal places."
          });
        }
      } else if (typeof body[key] !== "boolean") {
        return res.status(400).json({
          success: false,
          message: `${key} must be a boolean value.`
        });
      }
    }

    const settings = await getOrCreateSettings();
    const before = publicSettings(settings);

    for (const key of keys) settings[key] = body[key];
    settings.updatedBy = req.user._id;
    await settings.save();

    const after = publicSettings(settings);
    const changed = keys.filter(key => before[key] !== after[key]);

    if (changed.length) {
      await AdminAuditLog.create({
        adminId: req.user._id,
        targetUserId: req.user._id,
        action: "platform_settings_updated",
        reason: "Updated platform settings: " + changed.join(", "),
        before,
        after,
        ipAddress: String(req.ip || "").slice(0, 100)
      });
    }

    return res.json({
      success: true,
      message: changed.length ? "Platform settings saved." : "No settings changed.",
      data: after
    });
  } catch (error) {
    console.error("Admin settings update failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not save platform settings." });
  }
});

module.exports = router;
