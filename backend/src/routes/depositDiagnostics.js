const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const Deposit = require("../models/Deposit");
const DarajaCallbackEvent = require("../models/DarajaCallbackEvent");

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


router.get("/diagnostic/recent", async (req, res) => {
  try {
    const deposits = await Deposit.find({
      userId: req.user._id,
      paymentMode: "daraja"
    })
      .select("requestId status paymentMode checkoutRequestId resultCode resultDescription createdAt completedAt")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const results = await Promise.all(
      deposits.map(async deposit => {
        let callback = null;

        if (deposit.checkoutRequestId) {
          callback = await DarajaCallbackEvent.findOne({
            checkoutRequestId: deposit.checkoutRequestId
          })
            .select("resultCode resultDescription processingStatus receivedAt")
            .sort({ receivedAt: -1 })
            .lean();
        }

        return {
          requestId: deposit.requestId,
          status: deposit.status,
          resultCode: deposit.resultCode,
          resultDescription: deposit.resultDescription,
          createdAt: deposit.createdAt,
          completedAt: deposit.completedAt,
          callback: callback
            ? {
                resultCode: callback.resultCode,
                resultDescription: callback.resultDescription,
                processingStatus: callback.processingStatus,
                receivedAt: callback.receivedAt
              }
            : null
        };
      })
    );

    return res.json({
      success: true,
      count: results.length,
      deposits: results
    });
  } catch (error) {
    console.error("Recent deposit diagnostic error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not retrieve recent deposit diagnostics."
    });
  }
});

router.get("/diagnostic/:requestId", async (req, res) => {
  try {
    const requestId = req.params.requestId;

    if (
      typeof requestId !== "string" ||
      !/^DP-[0-9a-f-]{36}$/i.test(requestId)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid deposit request ID."
      });
    }

    const deposit = await Deposit.findOne({
      requestId,
      userId: req.user._id
    })
      .select("requestId status paymentMode checkoutRequestId resultCode resultDescription createdAt completedAt")
      .lean();

    if (!deposit) {
      return res.status(404).json({
        success: false,
        message: "Deposit not found."
      });
    }

    let callback = null;

    if (deposit.checkoutRequestId) {
      callback = await DarajaCallbackEvent.findOne({
        checkoutRequestId: deposit.checkoutRequestId
      })
        .select("resultCode resultDescription processingStatus receivedAt")
        .sort({ receivedAt: -1 })
        .lean();
    }

    return res.json({
      success: true,
      deposit: {
        requestId: deposit.requestId,
        status: deposit.status,
        paymentMode: deposit.paymentMode,
        resultCode: deposit.resultCode,
        resultDescription: deposit.resultDescription,
        createdAt: deposit.createdAt,
        completedAt: deposit.completedAt
      },
      callback: callback
        ? {
            resultCode: callback.resultCode,
            resultDescription: callback.resultDescription,
            processingStatus: callback.processingStatus,
            receivedAt: callback.receivedAt
          }
        : null
    });
  } catch (error) {
    console.error("Deposit diagnostic error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not retrieve deposit diagnostics."
    });
  }
});

module.exports = router;
