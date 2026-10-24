"use strict";

const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const {
  ChatServiceError,
  getMarketingWallet
} = require("../services/chatService");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const wallet = await getMarketingWallet(req.user, req.query.limit);
    return res.json({ success: true, wallet });
  } catch (error) {
    if (error instanceof ChatServiceError) {
      return res.status(error.status).json({
        success: false,
        message: error.message
      });
    }

    console.error("Marketing wallet load error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load marketing wallet."
    });
  }
});

module.exports = router;
