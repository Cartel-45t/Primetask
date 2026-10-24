"use strict";

const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const {
  ChatServiceError,
  createMemberConversation,
  createAdminConversation,
  listConversations,
  sendMessage,
  getMessages,
  getStreak
} = require("../services/chatService");

const router = express.Router();

function handleError(res, error, fallbackMessage) {
  if (error instanceof ChatServiceError) {
    return res.status(error.status).json({
      success: false,
      message: error.message
    });
  }

  console.error("Chat API error:", error.message);
  return res.status(500).json({
    success: false,
    message: fallbackMessage
  });
}

router.get("/conversations", requireAuth, async (req, res) => {
  try {
    const conversations = await listConversations(req.user);
    return res.json({ success: true, conversations });
  } catch (error) {
    return handleError(res, error, "Unable to load conversations.");
  }
});

router.post("/conversations/member", requireAuth, async (req, res) => {
  try {
    const conversation = await createMemberConversation(
      req.user,
      req.body?.username
    );

    const conversations = await listConversations(req.user);
    const view = conversations.find(
      (item) => item.id === String(conversation._id)
    );

    return res.status(200).json({
      success: true,
      conversation: view || { id: String(conversation._id), kind: "member" }
    });
  } catch (error) {
    return handleError(res, error, "Unable to start member conversation.");
  }
});

router.post("/conversations/admin", requireAuth, async (req, res) => {
  try {
    const conversation = await createAdminConversation(req.user);

    // The member-facing payload exposes only the label "Admin".
    return res.status(200).json({
      success: true,
      conversation: {
        id: String(conversation._id),
        kind: "admin",
        counterpart: { type: "admin", label: "Admin" },
        lastMessageAt: conversation.lastMessageAt || null,
        lastMessageId: conversation.lastMessageId
          ? String(conversation.lastMessageId)
          : null
      }
    });
  } catch (error) {
    return handleError(res, error, "Unable to open the Admin inbox.");
  }
});

router.get("/conversations/:id/messages", requireAuth, async (req, res) => {
  try {
    const messages = await getMessages(req.user, req.params.id, {
      limit: req.query.limit,
      before: req.query.before
    });

    return res.json({ success: true, messages });
  } catch (error) {
    return handleError(res, error, "Unable to load messages.");
  }
});

router.post("/conversations/:id/messages", requireAuth, async (req, res) => {
  try {
    const result = await sendMessage(
      req.user,
      req.params.id,
      req.body?.text
    );

    return res.status(201).json({
      success: true,
      message: result.message,
      streak: result.streak
    });
  } catch (error) {
    return handleError(res, error, "Unable to send message.");
  }
});

router.get("/conversations/:id/streak", requireAuth, async (req, res) => {
  try {
    const streak = await getStreak(req.user, req.params.id);
    return res.json({ success: true, streak });
  } catch (error) {
    return handleError(res, error, "Unable to load streak details.");
  }
});

module.exports = router;
