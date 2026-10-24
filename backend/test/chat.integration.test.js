"use strict";

require("dotenv").config();

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const testUri = process.env.PTW_TEST_MONGODB_URI;
const enabled = Boolean(testUri);

process.env.JWT_SECRET =
  process.env.PTW_TEST_JWT_SECRET ||
  "ptw-v3-chat-integration-test-secret-only";

const User = require("../src/models/User");
const ChatConversation = require("../src/models/ChatConversation");
const ChatMessage = require("../src/models/ChatMessage");
const ChatDailyActivity = require("../src/models/ChatDailyActivity");
const ChatStreak = require("../src/models/ChatStreak");
const ChatStreakDay = require("../src/models/ChatStreakDay");
const MarketingWallet = require("../src/models/MarketingWallet");
const MarketingWalletTransaction = require("../src/models/MarketingWalletTransaction");
const Notification = require("../src/models/Notification");

const chatRoutes = require("../src/routes/chat");
const notificationRoutes = require("../src/routes/notifications");
const marketingWalletRoutes = require("../src/routes/marketingWallet");
const { qualifyStreakDay } = require("../src/services/chatService");

let server;
let baseUrl;
let testUsers = [];

function makeToken(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      sv: Number(user.sessionVersion || 0)
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "1h",
      issuer: "primetask-workspace",
      audience: "primetask-workspace-users"
    }
  );
}

function cookieFor(user) {
  return `ptw_session=${makeToken(user)}`;
}

async function request(path, user, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(user ? { Cookie: cookieFor(user) } : {}),
    ...options.headers
  };

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers
  });

  return {
    response,
    body: await response.json()
  };
}

async function createUser(username, role = "user") {
  const number = testUsers.length + 1;

  const user = await User.create({
    firstName: `ChatTest${number}`,
    lastName: "PrivateIdentity",
    username,
    email: `${username}@example.test`,
    phone: `+254711${String(number).padStart(6, "0")}`,
    passwordHash: "integration-test-hash-not-used-for-login",
    role,
    status: "active",
    sessionVersion: 0
  });

  testUsers.push(user);
  return user;
}


async function createMemberConversation(memberA, memberB) {
  const created = await request(
    "/api/chat/conversations/member",
    memberA,
    {
      method: "POST",
      body: JSON.stringify({ username: memberB.username })
    }
  );

  assert.equal(created.response.status, 200);
  return created.body.conversation.id;
}

async function recordBothMembersActive(conversationId, members, dayKey) {
  const timestamp = new Date(`${dayKey}T12:00:00.000Z`);

  await ChatDailyActivity.create(
    members.map((member) => ({
      conversationId,
      userId: member._id,
      dayKey,
      messageCount: 1,
      firstMessageAt: timestamp,
      lastMessageAt: timestamp
    }))
  );
}

before(async () => {
  if (!enabled) return;

  let databaseName;

  try {
    databaseName = decodeURIComponent(
      new URL(testUri).pathname.replace(/^\/+/, "")
    );
  } catch {
    throw new Error("PTW_TEST_MONGODB_URI must be a valid MongoDB URI.");
  }

  if (!databaseName.toLowerCase().includes("test")) {
    throw new Error(
      "Safety stop: integration tests require a database name containing 'test'."
    );
  }

  await mongoose.connect(testUri, {
    serverSelectionTimeoutMS: 10000
  });

  await Promise.all([
    User.init(),
    ChatConversation.init(),
    ChatMessage.init(),
    ChatDailyActivity.init(),
    ChatStreak.init(),
    ChatStreakDay.init(),
    MarketingWallet.init(),
    MarketingWalletTransaction.init(),
    Notification.init()
  ]);

  const app = express();
  app.use(express.json({ limit: "20kb" }));
  app.use(cookieParser());
  app.use("/api/chat", chatRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/marketing-wallet", marketingWalletRoutes);

  server = app.listen(0, "127.0.0.1");

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  if (!enabled || mongoose.connection.readyState !== 1) return;

  await Promise.all([
    ChatMessage.deleteMany({}),
    ChatDailyActivity.deleteMany({}),
    ChatStreak.deleteMany({}),
    ChatStreakDay.deleteMany({}),
    MarketingWallet.deleteMany({}),
    MarketingWalletTransaction.deleteMany({}),
    Notification.deleteMany({}),
    ChatConversation.deleteMany({}),
    User.deleteMany({ username: /^chat_test_/ })
  ]);

  testUsers = [];
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  if (mongoose.connection.readyState === 1) {
    await Promise.all([
      ChatMessage.deleteMany({}),
      ChatDailyActivity.deleteMany({}),
      ChatStreak.deleteMany({}),
      ChatStreakDay.deleteMany({}),
      MarketingWallet.deleteMany({}),
      MarketingWalletTransaction.deleteMany({}),
      Notification.deleteMany({}),
      ChatConversation.deleteMany({}),
      User.deleteMany({ username: /^chat_test_/ })
    ]);

    await mongoose.disconnect();
  }
});

test("member-to-Admin conversation never exposes staff identity", {
  skip: !enabled
}, async () => {
  const member = await createUser("chat_test_member");
  await createUser("chat_test_private_staff", "admin");

  const opened = await request(
    "/api/chat/conversations/admin",
    member,
    { method: "POST", body: JSON.stringify({}) }
  );

  assert.equal(opened.response.status, 200);
  assert.equal(opened.body.success, true);
  assert.equal(opened.body.conversation.kind, "admin");
  assert.deepEqual(opened.body.conversation.counterpart, {
    type: "admin",
    label: "Admin"
  });

  const serialized = JSON.stringify(opened.body);
  assert.equal(serialized.includes("chat_test_private_staff"), false);
  assert.equal(serialized.includes("PrivateIdentity"), false);

  const listed = await request("/api/chat/conversations", member);
  assert.equal(listed.response.status, 200);

  const adminConversation = listed.body.conversations.find(
    (item) => item.id === opened.body.conversation.id
  );

  assert.ok(adminConversation);
  assert.deepEqual(adminConversation.counterpart, {
    type: "admin",
    label: "Admin"
  });

  const reply = await request(
    `/api/chat/conversations/${opened.body.conversation.id}/messages`,
    member,
    { method: "POST", body: JSON.stringify({ text: "Hello Admin" }) }
  );

  assert.equal(reply.response.status, 201);
  assert.equal(reply.body.message.text, "Hello Admin");

  const staff = testUsers.find((user) => user.role === "admin");

  const staffReply = await request(
    `/api/chat/conversations/${opened.body.conversation.id}/messages`,
    staff,
    { method: "POST", body: JSON.stringify({ text: "How can we help?" }) }
  );

  assert.equal(staffReply.response.status, 201);
  assert.deepEqual(staffReply.body.message.sender, {
    type: "admin",
    label: "Admin"
  });

  const history = await request(
    `/api/chat/conversations/${opened.body.conversation.id}/messages`,
    member
  );

  assert.equal(history.response.status, 200);
  assert.equal(history.body.messages.length, 2);
  assert.deepEqual(history.body.messages[1].sender, {
    type: "admin",
    label: "Admin"
  });

  assert.equal(
    JSON.stringify(history.body).includes("chat_test_private_staff"),
    false
  );
});

test("members cannot read or send messages in another member's conversation", {
  skip: !enabled
}, async () => {
  const memberA = await createUser("chat_test_member_a");
  const memberB = await createUser("chat_test_member_b");
  const memberC = await createUser("chat_test_member_c");

  const created = await request(
    "/api/chat/conversations/member",
    memberA,
    {
      method: "POST",
      body: JSON.stringify({ username: memberB.username })
    }
  );

  assert.equal(created.response.status, 200);
  const conversationId = created.body.conversation.id;

  const forbiddenRead = await request(
    `/api/chat/conversations/${conversationId}/messages`,
    memberC
  );

  assert.equal(forbiddenRead.response.status, 403);

  const forbiddenSend = await request(
    `/api/chat/conversations/${conversationId}/messages`,
    memberC,
    { method: "POST", body: JSON.stringify({ text: "Not my conversation" }) }
  );

  assert.equal(forbiddenSend.response.status, 403);
  assert.equal(await ChatMessage.countDocuments({ conversationId }), 0);
});

test("chat rejects empty and oversized messages", {
  skip: !enabled
}, async () => {
  const memberA = await createUser("chat_test_sender");
  const memberB = await createUser("chat_test_receiver");

  const created = await request(
    "/api/chat/conversations/member",
    memberA,
    {
      method: "POST",
      body: JSON.stringify({ username: memberB.username })
    }
  );

  assert.equal(created.response.status, 200);
  const conversationId = created.body.conversation.id;

  for (const text of ["   ", "x".repeat(4001)]) {
    const result = await request(
      `/api/chat/conversations/${conversationId}/messages`,
      memberA,
      { method: "POST", body: JSON.stringify({ text }) }
    );

    assert.equal(result.response.status, 400);
  }

  assert.equal(await ChatMessage.countDocuments({ conversationId }), 0);
});

test("notifications are private to their recipient", {
  skip: !enabled
}, async () => {
  const memberA = await createUser("chat_test_notify_a");
  const memberB = await createUser("chat_test_notify_b");

  const created = await request(
    "/api/chat/conversations/member",
    memberA,
    {
      method: "POST",
      body: JSON.stringify({ username: memberB.username })
    }
  );

  assert.equal(created.response.status, 200);

  const sent = await request(
    `/api/chat/conversations/${created.body.conversation.id}/messages`,
    memberA,
    { method: "POST", body: JSON.stringify({ text: "Private message" }) }
  );

  assert.equal(sent.response.status, 201);

  const ownNotifications = await request("/api/notifications", memberB);
  assert.equal(ownNotifications.response.status, 200);
  assert.equal(ownNotifications.body.notifications.length, 1);
  assert.equal(ownNotifications.body.notifications[0].type, "chat_message");

  const senderNotifications = await request("/api/notifications", memberA);
  assert.equal(senderNotifications.response.status, 200);
  assert.equal(senderNotifications.body.notifications.length, 0);
});

test("marketing wallet endpoint returns a separate USD balance", {
  skip: !enabled
}, async () => {
  const member = await createUser("chat_test_wallet");
  await MarketingWallet.create({
    userId: member._id,
    currency: "USD",
    balanceCents: 9,
    lifetimeRewardsCents: 9
  });

  const result = await request("/api/marketing-wallet", member);

  assert.equal(result.response.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.wallet.currency, "USD");
  assert.equal(result.body.wallet.balanceCents, 9);
  assert.equal(result.body.wallet.lifetimeRewardsCents, 9);
  assert.equal(Object.hasOwn(result.body.wallet, "withdrawals"), false);
});

test("chat endpoints reject unauthenticated requests", {
  skip: !enabled
}, async () => {
  const result = await request("/api/chat/conversations", null);

  assert.equal(result.response.status, 401);
  assert.equal(result.body.success, false);
});


test("database-backed streak rewards unlock on day six, continue daily, and cannot be paid twice", {
  skip: !enabled
}, async () => {
  const memberA = await createUser("chat_test_streak_a");
  const memberB = await createUser("chat_test_streak_b");
  const members = [memberA, memberB];

  const conversationId = await createMemberConversation(memberA, memberB);
  const days = [
    "2026-10-01",
    "2026-10-02",
    "2026-10-03",
    "2026-10-04",
    "2026-10-05",
    "2026-10-06",
    "2026-10-07"
  ];

  for (let index = 0; index < days.length; index += 1) {
    const dayKey = days[index];

    await recordBothMembersActive(conversationId, members, dayKey);

    const result = await qualifyStreakDay(conversationId, dayKey);
    assert.equal(result.qualified, true);
    assert.equal(result.streakDays, index + 1);

    if (index < 5) {
      assert.equal(result.rewardCentsPerParticipant, 0);
    } else {
      assert.equal(result.rewardCentsPerParticipant, 3);
    }
  }

  // Reprocessing the last day must not issue another reward.
  await qualifyStreakDay(conversationId, days[6]);

  for (const member of members) {
    const wallet = await MarketingWallet.findOne({
      userId: member._id
    }).lean();

    assert.equal(wallet.balanceCents, 6);
    assert.equal(wallet.lifetimeRewardsCents, 6);

    assert.equal(
      await MarketingWalletTransaction.countDocuments({
        userId: member._id,
        type: "chat_streak_reward"
      }),
      2
    );
  }

  assert.equal(
    await ChatStreakDay.countDocuments({ conversationId }),
    7
  );

  const streak = await ChatStreak.findOne({ conversationId }).lean();
  assert.equal(streak.currentStreakDays, 7);
  assert.equal(streak.longestStreakDays, 7);
  assert.equal(streak.rewardsActive, true);
});

test("a missed day resets the streak but preserves earned rewards", {
  skip: !enabled
}, async () => {
  const memberA = await createUser("chat_test_gap_a");
  const memberB = await createUser("chat_test_gap_b");
  const members = [memberA, memberB];

  const conversationId = await createMemberConversation(memberA, memberB);
  const firstSixDays = [
    "2026-10-01",
    "2026-10-02",
    "2026-10-03",
    "2026-10-04",
    "2026-10-05",
    "2026-10-06"
  ];

  for (const dayKey of firstSixDays) {
    await recordBothMembersActive(conversationId, members, dayKey);
    await qualifyStreakDay(conversationId, dayKey);
  }

  // October 7 is deliberately missed.
  await recordBothMembersActive(
    conversationId,
    members,
    "2026-10-08"
  );

  const result = await qualifyStreakDay(
    conversationId,
    "2026-10-08"
  );

  assert.equal(result.qualified, true);
  assert.equal(result.streakDays, 1);
  assert.equal(result.rewardCentsPerParticipant, 0);

  for (const member of members) {
    const wallet = await MarketingWallet.findOne({
      userId: member._id
    }).lean();

    // The day-six reward remains in the wallet.
    assert.equal(wallet.balanceCents, 3);
    assert.equal(wallet.lifetimeRewardsCents, 3);

    assert.equal(
      await MarketingWalletTransaction.countDocuments({
        userId: member._id,
        type: "chat_streak_reward"
      }),
      1
    );
  }

  const streak = await ChatStreak.findOne({ conversationId }).lean();
  assert.equal(streak.currentStreakDays, 1);
  assert.equal(streak.longestStreakDays, 6);
  assert.equal(streak.rewardsActive, false);
});


test("concurrent requests reuse one member conversation", {
  skip: !enabled
}, async () => {
  const memberA = await createUser("chat_test_race_a");
  const memberB = await createUser("chat_test_race_b");

  const payload = {
    method: "POST",
    body: JSON.stringify({ username: memberB.username })
  };

  const results = await Promise.all([
    request("/api/chat/conversations/member", memberA, payload),
    request("/api/chat/conversations/member", memberA, payload)
  ]);

  assert.deepEqual(
    results.map((result) => result.response.status),
    [200, 200]
  );

  assert.equal(
    results[0].body.conversation.id,
    results[1].body.conversation.id
  );

  assert.equal(
    await ChatConversation.countDocuments({
      kind: "member",
      participantIds: { $all: [memberA._id, memberB._id] }
    }),
    1
  );
});


test("member messages notify all active Admin and Founder accounts", {
  skip: !enabled
}, async () => {
  const member = await createUser("chat_test_shared_member");
  const admin = await createUser("chat_test_shared_admin", "admin");
  const founder = await createUser("chat_test_shared_founder", "founder");
  const unrelated = await createUser("chat_test_shared_unrelated");

  const opened = await request(
    "/api/chat/conversations/admin",
    member,
    { method: "POST", body: JSON.stringify({}) }
  );

  assert.equal(opened.response.status, 200);

  const conversationId = opened.body.conversation.id;

  const sent = await request(
    `/api/chat/conversations/${conversationId}/messages`,
    member,
    {
      method: "POST",
      body: JSON.stringify({ text: "Need help with my account." })
    }
  );

  assert.equal(sent.response.status, 201);

  for (const staff of [admin, founder]) {
    const inbox = await request("/api/notifications", staff);

    assert.equal(inbox.response.status, 200);
    assert.equal(
      inbox.body.notifications.filter(
        (item) => item.type === "chat_message"
      ).length,
      1
    );
  }

  const unrelatedInbox = await request("/api/notifications", unrelated);
  assert.equal(unrelatedInbox.response.status, 200);
  assert.equal(unrelatedInbox.body.notifications.length, 0);

  // Staff identity must not leak through the member-facing conversation.
  const memberView = await request("/api/chat/conversations", member);

  assert.equal(
    JSON.stringify(memberView.body).includes(admin.username),
    false
  );
  assert.equal(
    JSON.stringify(memberView.body).includes(founder.username),
    false
  );

  // A staff reply should notify the member, not create more staff alerts.
  const staffReply = await request(
    `/api/chat/conversations/${conversationId}/messages`,
    founder,
    {
      method: "POST",
      body: JSON.stringify({ text: "We will assist you." })
    }
  );

  assert.equal(staffReply.response.status, 201);
  assert.deepEqual(staffReply.body.message.sender, {
    type: "admin",
    label: "Admin"
  });

  const memberInbox = await request("/api/notifications", member);
  assert.equal(
    memberInbox.body.notifications.filter(
      (item) => item.type === "chat_message"
    ).length,
    1
  );

  for (const staff of [admin, founder]) {
    const inbox = await request("/api/notifications", staff);
    assert.equal(
      inbox.body.notifications.filter(
        (item) => item.type === "chat_message"
      ).length,
      1
    );
  }
});
