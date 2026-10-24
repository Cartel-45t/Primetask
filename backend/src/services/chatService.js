"use strict";

const mongoose = require("mongoose");

const User = require("../models/User");
const ChatConversation = require("../models/ChatConversation");
const ChatMessage = require("../models/ChatMessage");
const ChatDailyActivity = require("../models/ChatDailyActivity");
const ChatStreak = require("../models/ChatStreak");
const ChatStreakDay = require("../models/ChatStreakDay");
const MarketingWallet = require("../models/MarketingWallet");
const MarketingWalletTransaction = require("../models/MarketingWalletTransaction");
const Notification = require("../models/Notification");

const {
  STREAK_UNLOCK_DAYS,
  REWARD_CENTS_PER_PARTICIPANT,
  getKenyaDayKey,
  calculateNextStreak
} = require("./chatStreakService");

const PRIVILEGED_ROLES = ["admin", "founder"];
const MESSAGE_MAX_LENGTH = 4000;

class ChatServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ChatServiceError";
    this.status = status;
  }
}

function fail(status, message) {
  throw new ChatServiceError(status, message);
}

function idOf(value) {
  return String(value?._id || value);
}

function isPrivileged(user) {
  return PRIVILEGED_ROLES.includes(user.role);
}

function requireActiveUser(user) {
  if (!user || !user._id || user.status !== "active") {
    fail(401, "An active authenticated account is required.");
  }
}

function conversationKeyForMembers(firstId, secondId) {
  const ids = [idOf(firstId), idOf(secondId)].sort();
  return `member:${ids[0]}:${ids[1]}`;
}

function conversationKeyForAdmin(memberId) {
  return `admin:${idOf(memberId)}`;
}

function assertConversationAccess(conversation, user) {
  if (!conversation || !conversation.active) {
    fail(404, "Conversation not found.");
  }

  const isParticipant = conversation.participantIds.some(
    (participantId) => idOf(participantId) === idOf(user._id)
  );

  // Admin conversations are a shared inbox. Privileged staff can respond
  // without exposing any staff member's identity to the contacting member.
  if (conversation.kind === "admin" && isPrivileged(user)) {
    return;
  }

  if (!isParticipant) {
    fail(403, "You do not have access to this conversation.");
  }
}

function safeConversationView(conversation, currentUser, users = []) {
  const userById = new Map(users.map((user) => [idOf(user), user]));

  if (conversation.kind === "admin") {
    if (isPrivileged(currentUser)) {
      const member = conversation.participantIds
        .map((id) => userById.get(idOf(id)))
        .find((user) => user && !isPrivileged(user));

      return {
        id: idOf(conversation),
        kind: "admin",
        counterpart: member
          ? { type: "member", username: member.username }
          : { type: "member", username: null },
        lastMessageAt: conversation.lastMessageAt || null,
        lastMessageId: conversation.lastMessageId
          ? idOf(conversation.lastMessageId)
          : null
      };
    }

    // Never serialize staff names, usernames, or staff IDs to members.
    return {
      id: idOf(conversation),
      kind: "admin",
      counterpart: { type: "admin", label: "Admin" },
      lastMessageAt: conversation.lastMessageAt || null,
      lastMessageId: conversation.lastMessageId
        ? idOf(conversation.lastMessageId)
        : null
    };
  }

  const counterpartId = conversation.participantIds.find(
    (participantId) => idOf(participantId) !== idOf(currentUser._id)
  );
  const counterpart = counterpartId
    ? userById.get(idOf(counterpartId))
    : null;

  return {
    id: idOf(conversation),
    kind: "member",
    counterpart: counterpart
      ? { type: "member", username: counterpart.username }
      : { type: "member", username: null },
    lastMessageAt: conversation.lastMessageAt || null,
    lastMessageId: conversation.lastMessageId
      ? idOf(conversation.lastMessageId)
      : null
  };
}

async function findOrCreateConversation({
  kind,
  participantIds,
  conversationKey
}) {
  const session = await mongoose.startSession();
  let conversation;

  function validateExisting(candidate) {
    const existingIds = (candidate?.participantIds || []).map(idOf);

    const matches = candidate &&
      candidate.kind === kind &&
      (
        kind === "admin"
          ? existingIds.length === 2 &&
            existingIds.includes(idOf(participantIds[0]))
          : existingIds.length === 2 &&
            participantIds.every((id) => existingIds.includes(idOf(id)))
      );

    if (!matches) {
      fail(409, "The existing conversation does not match this request.");
    }
  }

  try {
    await session.withTransaction(async () => {
      conversation = await ChatConversation.findOneAndUpdate(
        { conversationKey },
        {
          $setOnInsert: {
            kind,
            participantIds,
            conversationKey,
            active: true
          }
        },
        {
          new: true,
          upsert: true,
          runValidators: true,
          session
        }
      );

      validateExisting(conversation);
    });
  } catch (error) {
    if (!error || error.code !== 11000) {
      throw error;
    }

    // Another request may have won the unique-key race.
    // Reuse its record only after validating the conversation.
    conversation = await ChatConversation.findOne({ conversationKey });

    if (!conversation) {
      throw error;
    }

    validateExisting(conversation);
  } finally {
    await session.endSession();
  }

  return conversation;
}
async function createMemberConversation(currentUser, username) {
  requireActiveUser(currentUser);

  if (isPrivileged(currentUser)) {
    fail(403, "This action is for member accounts.");
  }

  if (typeof username !== "string") {
    fail(400, "A member username is required.");
  }

  const normalizedUsername = username.trim().toLowerCase();

  if (
    normalizedUsername.length < 3 ||
    normalizedUsername.length > 40 ||
    !/^[a-z0-9_]+$/.test(normalizedUsername)
  ) {
    fail(400, "Enter a valid member username.");
  }

  const otherUser = await User.findOne({
    username: normalizedUsername,
    status: "active",
    role: "user"
  }).select("_id username role status");

  if (!otherUser) {
    fail(404, "Active member not found.");
  }

  if (idOf(otherUser) === idOf(currentUser._id)) {
    fail(400, "You cannot start a conversation with yourself.");
  }

  const participantIds = [currentUser._id, otherUser._id];

  return findOrCreateConversation({
    kind: "member",
    participantIds,
    conversationKey: conversationKeyForMembers(
      currentUser._id,
      otherUser._id
    )
  });
}

async function createAdminConversation(currentUser) {
  requireActiveUser(currentUser);

  if (isPrivileged(currentUser)) {
    fail(403, "Only a member can open a member-to-admin conversation.");
  }

  const conversationKey = conversationKeyForAdmin(currentUser._id);

  // Reuse an existing inbox before looking up staff. A staff account
  // becoming inactive must not break an established member conversation.
  const existing = await ChatConversation.findOne({
    conversationKey,
    kind: "admin",
    active: true,
    participantIds: currentUser._id
  });

  if (existing) {
    return existing;
  }

  // Prefer an active admin. Fall back to an active founder.
  // Staff identity is never exposed in member-facing chat responses.
  const staff = await User.findOne({
    role: "admin",
    status: "active"
  }).select("_id");

  const fallbackStaff = staff || await User.findOne({
    role: "founder",
    status: "active"
  }).select("_id");

  if (!fallbackStaff) {
    fail(503, "The Admin inbox is currently unavailable.");
  }

  return findOrCreateConversation({
    kind: "admin",
    participantIds: [currentUser._id, fallbackStaff._id],
    conversationKey
  });
}

async function listConversations(currentUser) {
  requireActiveUser(currentUser);

  const query = isPrivileged(currentUser)
    ? { kind: "admin", active: true }
    : { participantIds: currentUser._id, active: true };

  const conversations = await ChatConversation.find(query)
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .limit(100)
    .lean();

  const ids = [
    ...new Set(conversations.flatMap((conversation) =>
      conversation.participantIds.map(idOf)
    ))
  ];

  const users = await User.find({ _id: { $in: ids } })
    .select("_id username role")
    .lean();

  return conversations.map((conversation) =>
    safeConversationView(conversation, currentUser, users)
  );
}

async function sendMessage(currentUser, conversationId, rawText) {
  requireActiveUser(currentUser);

  if (!mongoose.isValidObjectId(conversationId)) {
    fail(400, "Invalid conversation ID.");
  }

  if (typeof rawText !== "string") {
    fail(400, "Message text is required.");
  }

  const text = rawText.trim();

  if (!text || text.length > MESSAGE_MAX_LENGTH) {
    fail(400, `Messages must contain 1 to ${MESSAGE_MAX_LENGTH} characters.`);
  }

  const now = new Date();
  const dayKey = getKenyaDayKey(now);
  const session = await mongoose.startSession();
  let createdMessage;

  try {
    await session.withTransaction(async () => {
      const conversation = await ChatConversation.findById(
        conversationId
      ).session(session);

      assertConversationAccess(conversation, currentUser);

      if (
        conversation.kind === "member" &&
        isPrivileged(currentUser)
      ) {
        fail(403, "Staff accounts cannot send messages in member conversations.");
      }

      createdMessage = await ChatMessage.create([{
        conversationId: conversation._id,
        senderId: currentUser._id,
        text,
        messageType: "text",
        createdAt: now,
        updatedAt: now
      }], { session }).then((docs) => docs[0]);

      await ChatDailyActivity.updateOne(
        {
          conversationId: conversation._id,
          userId: currentUser._id,
          dayKey
        },
        {
          $inc: { messageCount: 1 },
          $set: { lastMessageAt: now },
          $setOnInsert: { firstMessageAt: now }
        },
        {
          upsert: true,
          session,
          runValidators: true
        }
      );

      conversation.lastMessageAt = now;
      conversation.lastMessageId = createdMessage._id;
      await conversation.save({ session });

      let recipientIds = [];

      if (conversation.kind === "admin") {
        if (isPrivileged(currentUser)) {
          // A staff reply notifies the member only, never other staff.
          const conversationMembers = await User.find({
            _id: { $in: conversation.participantIds },
            role: "user",
            status: "active"
          }).select("_id").session(session).lean();

          recipientIds = conversationMembers.map((member) => member._id);
        } else {
          // The Admin inbox is shared by every active Admin and Founder.
          const activeStaff = await User.find({
            role: { $in: PRIVILEGED_ROLES },
            status: "active"
          }).select("_id").session(session).lean();

          recipientIds = activeStaff.map((staff) => staff._id);
        }
      } else {
        recipientIds = conversation.participantIds.filter(
          (participantId) => idOf(participantId) !== idOf(currentUser._id)
        );
      }

      if (recipientIds.length) {
        await Notification.insertMany(
          recipientIds.map((recipientId) => ({
            recipientId,
            type: "chat_message",
            conversationId: conversation._id,
            messageId: createdMessage._id,
            createdAt: now,
            updatedAt: now
          })),
          { session }
        );
      }
    });
  } finally {
    await session.endSession();
  }

  // Reward processing is isolated from message delivery. Once the message
  // transaction commits, a streak failure must not report the message as failed.
  let streakResult = {
    qualified: false,
    streakDays: null,
    rewardsUnlocked: null,
    rewardCentsPerParticipant: 0,
    temporarilyUnavailable: false
  };

  try {
    streakResult = await qualifyStreakDay(
      createdMessage.conversationId,
      dayKey
    );
  } catch {
    // Keep the message successful; streak details can be fetched again.
    streakResult.temporarilyUnavailable = true;
    console.error("Chat streak qualification failed after message persistence.");
  }

  return {
    message: {
      id: idOf(createdMessage),
      conversationId: idOf(createdMessage.conversationId),
      text: createdMessage.text,
      messageType: "text",
      createdAt: createdMessage.createdAt,
      sender: isPrivileged(currentUser)
        ? { type: "admin", label: "Admin" }
        : { type: "member", username: currentUser.username }
    },
    streak: streakResult
  };
}

async function qualifyStreakDay(conversationId, dayKey) {
  const session = await mongoose.startSession();
  let result = {
    qualified: false,
    streakDays: 0,
    rewardsUnlocked: false,
    rewardCentsPerParticipant: 0
  };

  try {
    await session.withTransaction(async () => {
      const conversation = await ChatConversation.findById(
        conversationId
      ).session(session);

      if (!conversation || !conversation.active) {
        return;
      }

      // Support conversations with Admin are not reward partnerships.
      if (conversation.kind !== "member") {
        return;
      }

      const participantIds = conversation.participantIds;

      if (participantIds.length !== 2) {
        return;
      }

      const participants = await User.find({
        _id: { $in: participantIds },
        status: "active",
        role: "user"
      }).select("_id").session(session).lean();

      // Never credit staff accounts through chat streaks.
      if (participants.length !== 2) {
        return;
      }

      const activities = await ChatDailyActivity.find({
        conversationId,
        dayKey,
        userId: { $in: participantIds }
      }).session(session).lean();

      const activeIds = new Set(activities.map((activity) => idOf(activity.userId)));

      if (!participantIds.every((participantId) => activeIds.has(idOf(participantId)))) {
        return;
      }

      const previousStreak = await ChatStreak.findOne({
        conversationId
      }).session(session).lean();

      const next = calculateNextStreak({
        currentStreakDays: previousStreak?.currentStreakDays || 0,
        lastQualifiedDayKey: previousStreak?.lastQualifiedDayKey || null,
        qualifyingDayKey: dayKey
      });

      if (next.alreadyQualified) {
        result = {
          qualified: true,
          streakDays: next.streakDays,
          rewardsUnlocked: next.streakDays >= STREAK_UNLOCK_DAYS,
          rewardCentsPerParticipant: next.streakDays >= STREAK_UNLOCK_DAYS
            ? REWARD_CENTS_PER_PARTICIPANT
            : 0
        };
        return;
      }

      const rewardCents = next.streakDays >= STREAK_UNLOCK_DAYS
        ? REWARD_CENTS_PER_PARTICIPANT
        : 0;

      // Unique (conversationId, dayKey) is the concurrency guard.
      await ChatStreakDay.create([{
        conversationId,
        dayKey,
        participantIds,
        qualifiedAt: new Date(),
        streakDayNumber: next.streakDays,
        rewardCentsPerParticipant: rewardCents,
        unlockedNow: next.streakDays === STREAK_UNLOCK_DAYS
      }], { session });

      await ChatStreak.findOneAndUpdate(
        { conversationId },
        {
          $set: {
            currentStreakDays: next.streakDays,
            lastQualifiedDayKey: dayKey,
            rewardsActive: next.streakDays >= STREAK_UNLOCK_DAYS,
            ...(next.streakDays === STREAK_UNLOCK_DAYS
              ? { unlockedAt: new Date() }
              : {})
          },
          $max: { longestStreakDays: next.streakDays },
          $setOnInsert: { conversationId }
        },
        {
          upsert: true,
          new: true,
          runValidators: true,
          session
        }
      );

      if (rewardCents > 0) {
        for (const participantId of participantIds) {
          const userId = idOf(participantId);
          const idempotencyKey =
            `chat-streak:${idOf(conversationId)}:${dayKey}:${userId}`;

          // The wallet and ledger update are in the same transaction.
          await MarketingWallet.updateOne(
            { userId: participantId },
            {
              $setOnInsert: {
                userId: participantId,
                currency: "USD"
              },
              $inc: {
                balanceCents: rewardCents,
                lifetimeRewardsCents: rewardCents
              }
            },
            { upsert: true, session, runValidators: true }
          );

          await MarketingWalletTransaction.create([{
            userId: participantId,
            type: "chat_streak_reward",
            amountCents: rewardCents,
            currency: "USD",
            conversationId,
            qualifyingDayKey: dayKey,
            idempotencyKey,
            description: "PrimeTask Chat streak reward"
          }], { session });

          await Notification.create([{
            recipientId: participantId,
            type: "chat_streak_reward",
            conversationId
          }], { session });
        }
      }

      if (next.streakDays === STREAK_UNLOCK_DAYS) {
        await Notification.insertMany(
          participantIds.map((recipientId) => ({
            recipientId,
            type: "chat_streak_unlocked",
            conversationId
          })),
          { session }
        );
      }

      result = {
        qualified: true,
        streakDays: next.streakDays,
        rewardsUnlocked: next.streakDays >= STREAK_UNLOCK_DAYS,
        rewardCentsPerParticipant: rewardCents
      };
    });
  } catch (error) {
    // A concurrent request may have qualified the same day first.
    // The transaction is rolled back, including any partial wallet changes.
    if (error && error.code === 11000) {
      return {
        qualified: true,
        duplicateQualification: true,
        streakDays: null,
        rewardsUnlocked: null,
        rewardCentsPerParticipant: 0
      };
    }

    throw error;
  } finally {
    await session.endSession();
  }

  return result;
}

async function getMessages(currentUser, conversationId, options = {}) {
  requireActiveUser(currentUser);

  if (!mongoose.isValidObjectId(conversationId)) {
    fail(400, "Invalid conversation ID.");
  }

  const conversation = await ChatConversation.findById(conversationId).lean();
  assertConversationAccess(conversation, currentUser);

  const limitValue = Number(options.limit);
  const limit = Number.isInteger(limitValue)
    ? Math.max(1, Math.min(limitValue, 100))
    : 50;

  const query = { conversationId: conversation._id };

  if (options.before) {
    const beforeDate = new Date(options.before);

    if (Number.isNaN(beforeDate.getTime())) {
      fail(400, "Invalid message cursor.");
    }

    query.createdAt = { $lt: beforeDate };
  }

  const messages = await ChatMessage.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .lean();

  const senderIds = [...new Set(messages.map((message) => idOf(message.senderId)))];
  const senders = await User.find({ _id: { $in: senderIds } })
    .select("_id username role")
    .lean();

  const senderById = new Map(senders.map((sender) => [idOf(sender), sender]));

  return messages.reverse().map((message) => {
    const sender = senderById.get(idOf(message.senderId));
    const senderIsStaff = sender && isPrivileged(sender);

    return {
      id: idOf(message),
      conversationId: idOf(message.conversationId),
      text: message.text,
      messageType: "text",
      createdAt: message.createdAt,
      sender: conversation.kind === "admin" && senderIsStaff
        ? { type: "admin", label: "Admin" }
        : {
            type: "member",
            username: sender?.username || null
          }
    };
  });
}

async function getStreak(currentUser, conversationId) {
  requireActiveUser(currentUser);

  if (!mongoose.isValidObjectId(conversationId)) {
    fail(400, "Invalid conversation ID.");
  }

  const conversation = await ChatConversation.findById(conversationId).lean();
  assertConversationAccess(conversation, currentUser);

  const [streak, today] = await Promise.all([
    ChatStreak.findOne({ conversationId }).lean(),
    ChatDailyActivity.find({
      conversationId,
      dayKey: getKenyaDayKey(),
      userId: { $in: conversation.participantIds }
    }).select("userId messageCount").lean()
  ]);

  return {
    conversationId: idOf(conversation),
    timeZone: "Africa/Nairobi",
    requiredConsecutiveDays: STREAK_UNLOCK_DAYS,
    rewardCentsPerParticipant: REWARD_CENTS_PER_PARTICIPANT,
    currentStreakDays: streak?.currentStreakDays || 0,
    longestStreakDays: streak?.longestStreakDays || 0,
    rewardsActive: streak?.rewardsActive || false,
    todayActiveParticipantCount: today.length,
    participantCount: conversation.participantIds.length
  };
}

async function getMarketingWallet(currentUser, limit = 50) {
  requireActiveUser(currentUser);

  const safeLimit = Number.isInteger(Number(limit))
    ? Math.max(1, Math.min(Number(limit), 100))
    : 50;

  const [wallet, transactions] = await Promise.all([
    MarketingWallet.findOne({ userId: currentUser._id }).lean(),
    MarketingWalletTransaction.find({ userId: currentUser._id })
      .sort({ createdAt: -1 })
      .limit(safeLimit)
      .lean()
  ]);

  return {
    currency: "USD",
    balanceCents: wallet?.balanceCents || 0,
    lifetimeRewardsCents: wallet?.lifetimeRewardsCents || 0,
    transactions: transactions.map((transaction) => ({
      id: idOf(transaction),
      type: transaction.type,
      amountCents: transaction.amountCents,
      currency: transaction.currency,
      description: transaction.description,
      qualifyingDayKey: transaction.qualifyingDayKey,
      createdAt: transaction.createdAt
    }))
  };
}

module.exports = {
  ChatServiceError,
  createMemberConversation,
  createAdminConversation,
  listConversations,
  sendMessage,
  getMessages,
  getStreak,
  qualifyStreakDay,
  getMarketingWallet
};
