const express = require("express");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

router.use(requireAuth);

router.get("/status", (req, res) => {
  const required = [
    "DARAJA_CONSUMER_KEY",
    "DARAJA_CONSUMER_SECRET",
    "DARAJA_SHORTCODE",
    "DARAJA_PASSKEY"
  ];

  let callbackHttps = false;

  try {
    callbackHttps =
      new URL(process.env.DARAJA_CALLBACK_URL).protocol === "https:";
  } catch {}

  const missing = required.filter(
    name => !String(process.env[name] || "").trim()
  );

  const liveEnabled = process.env.DARAJA_LIVE_ENABLED === "true";
  const environment = process.env.DARAJA_ENV || "unset";
  const productionMode = environment === "production";

  return res.json({
    success: true,
    service: "deposit-diagnostics",
    liveEnabled,
    environment,
    credentialsPresent: missing.length === 0,
    missingVariables: missing,
    callbackHttps,
    configurationReady:
      liveEnabled &&
      productionMode &&
      missing.length === 0 &&
      callbackHttps
  });
});

module.exports = router;
