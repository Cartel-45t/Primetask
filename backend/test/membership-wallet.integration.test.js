"use strict";

require("dotenv").config();

const { randomUUID } = require("node:crypto");
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const User = require("../src/models/User");
const Wallet = require("../src/models/Wallet");
const WalletTransaction = require("../src/models/WalletTransaction");
const MembershipPlan = require("../src/models/MembershipPlan");
const MembershipPurchase = require("../src/models/MembershipPurchase");
const Membership = require("../src/models/Membership");
const Commission = require("../src/models/Commission");

const {
  fulfilMembershipPurchase
} = require("../src/services/membershipFulfilmentService");

const uri = process.env.PTW_TEST_MONGODB_URI;
const fixtureUserIds = [];
const fixturePlanIds = [];
const fixturePurchaseIds = [];

let connected = false;

before(async () => {
  if (!uri) return;

  const databaseName = decodeURIComponent(
    new URL(uri).pathname.replace(/^\/+/, "")
  );

  assert.match(
    databaseName.toLowerCase(),
    /test/,
    "Refusing to run outside a database whose name contains 'test'"
  );

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  connected = true;

  await Promise.all([
    User.init(),
    Wallet.init(),
    WalletTransaction.init(),
    MembershipPlan.init(),
    MembershipPurchase.init(),
    Membership.init(),
    Commission.init()
  ]);
});

after(async () => {
  if (!connected) return;

  try {
    const memberships = await Membership.find({
      purchaseId: { $in: fixturePurchaseIds }
    }).select("_id").lean();

    const membershipIds = memberships.map(item => item._id);

    if (membershipIds.length) {
      await Commission.deleteMany({
        membershipId: { $in: membershipIds }
      });
    }

    await WalletTransaction.deleteMany({
      $or: [
        { membershipPurchaseId: { $in: fixturePurchaseIds } },
        { userId: { $in: fixtureUserIds } }
      ]
    });

    await Membership.deleteMany({
      $or: [
        { purchaseId: { $in: fixturePurchaseIds } },
        { userId: { $in: fixtureUserIds } }
      ]
    });

    await MembershipPurchase.deleteMany({
      _id: { $in: fixturePurchaseIds }
    });

    await Wallet.deleteMany({
      userId: { $in: fixtureUserIds }
    });

    await MembershipPlan.deleteMany({
      _id: { $in: fixturePlanIds }
    });

    await User.deleteMany({
      _id: { $in: fixtureUserIds }
    });
  } finally {
    await mongoose.disconnect();
  }
});

async function createFixture({
  balanceCents,
  priceCents = 2500,
  paymentMethod = "wallet"
}) {
  const suffix = randomUUID().replace(/-/g, "");
  const userId = new mongoose.Types.ObjectId();
  const planId = new mongoose.Types.ObjectId();

  fixtureUserIds.push(userId);
  fixturePlanIds.push(planId);

  await User.create({
    _id: userId,
    firstName: "Wallet",
    lastName: "Test",
    username: `wallet_${suffix.slice(0, 20)}`,
    email: `wallet-${suffix}@example.test`,
    phone: `test-${suffix.slice(0, 12)}`,
    passwordHash: "integration-test-hash-not-a-real-password",
    role: "user",
    status: "active",
    referredBy: null
  });

  await Wallet.create({
    userId,
    currency: "USD",
    availableBalanceCents: balanceCents,
    pendingEarningsCents: 0,
    totalEarningsCents: 0,
    totalWithdrawalsCents: 0
  });

  const plan = await MembershipPlan.create({
    _id: planId,
    key: `wallet-test-${suffix.slice(0, 16)}`,
    name: "Wallet Integration Test",
    priceCents,
    currency: "USD",
    durationDays: 30,
    services: ["data-entry"],
    commissionAmountsCents: [0, 0, 0, 0],
    commissionEnabled: false,
    active: true,
    mpesaAmountKes: null
  });

  const purchaseData = {
    purchaserUserId: userId,
    planId,
    planKey: plan.key,
    idempotencyKey: `wallet-test-${suffix}`,
    priceCents,
    currency: "USD",
    paymentMethod,
    durationDays: plan.durationDays,
    services: plan.services,
    commissionEnabledSnapshot: false,
    commissionAmountsCentsSnapshot: [0, 0, 0, 0],
    paymentStatus: "pending"
  };

  if (paymentMethod === "daraja") {
    purchaseData.expectedAmountKes = 500;
    purchaseData.phoneNumber = "254700000001";
  }

  const purchase = await MembershipPurchase.create(purchaseData);
  fixturePurchaseIds.push(purchase._id);

  return { userId, plan, purchase };
}

test("wallet purchase debits exact USD cents and activates one membership", async t => {
  if (!uri) return t.skip("PTW_TEST_MONGODB_URI is not configured");

  const { userId, purchase } = await createFixture({
    balanceCents: 10000,
    priceCents: 2500
  });

  const result = await fulfilMembershipPurchase(purchase._id, {
    paymentMethod: "wallet"
  });

  assert.equal(result.purchaseId, String(purchase._id));
  assert.ok(result.membershipId);

  const wallet = await Wallet.findOne({ userId }).lean();
  assert.equal(wallet.availableBalanceCents, 7500);
  assert.equal(wallet.currency, "USD");

  const ledger = await WalletTransaction.find({
    membershipPurchaseId: purchase._id
  }).lean();

  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].type, "membership_purchase");
  assert.equal(ledger[0].amountCents, 2500);
  assert.equal(ledger[0].currency, "USD");
  assert.equal(ledger[0].status, "completed");

  const membership = await Membership.findOne({
    purchaseId: purchase._id
  }).lean();

  assert.ok(membership);
  assert.equal(membership.status, "active");
  assert.equal(membership.priceCents, 2500);
  assert.equal(membership.currency, "USD");
  assert.ok(membership.startsAt);
  assert.ok(membership.expiresAt > membership.startsAt);

  const savedPurchase = await MembershipPurchase.findById(purchase._id).lean();
  assert.equal(savedPurchase.paymentStatus, "verified");
  assert.equal(String(savedPurchase.membershipId), String(membership._id));
});

test("insufficient wallet balance creates no membership or debit ledger", async t => {
  if (!uri) return t.skip("PTW_TEST_MONGODB_URI is not configured");

  const { userId, purchase } = await createFixture({
    balanceCents: 1000,
    priceCents: 2500
  });

  await assert.rejects(
    fulfilMembershipPurchase(purchase._id, { paymentMethod: "wallet" }),
    error => error.code === "INSUFFICIENT_WALLET_BALANCE"
  );

  const wallet = await Wallet.findOne({ userId }).lean();
  assert.equal(wallet.availableBalanceCents, 1000);

  assert.equal(
    await Membership.countDocuments({ purchaseId: purchase._id }),
    0
  );

  assert.equal(
    await WalletTransaction.countDocuments({
      membershipPurchaseId: purchase._id
    }),
    0
  );

  const savedPurchase = await MembershipPurchase.findById(purchase._id).lean();
  assert.equal(savedPurchase.paymentStatus, "pending");
  assert.equal(savedPurchase.membershipId, null);
});

test("wallet fulfilment cannot bypass Daraja payment verification", async t => {
  if (!uri) return t.skip("PTW_TEST_MONGODB_URI is not configured");

  const { userId, purchase } = await createFixture({
    balanceCents: 10000,
    priceCents: 2500,
    paymentMethod: "daraja"
  });

  await assert.rejects(
    fulfilMembershipPurchase(purchase._id, { paymentMethod: "wallet" }),
    error => error.code === "PAYMENT_NOT_VERIFIED"
  );

  const wallet = await Wallet.findOne({ userId }).lean();
  assert.equal(wallet.availableBalanceCents, 10000);

  assert.equal(
    await Membership.countDocuments({ purchaseId: purchase._id }),
    0
  );

  assert.equal(
    await WalletTransaction.countDocuments({
      membershipPurchaseId: purchase._id
    }),
    0
  );

  const savedPurchase = await MembershipPurchase.findById(purchase._id).lean();
  assert.equal(savedPurchase.paymentMethod, "daraja");
  assert.equal(savedPurchase.paymentStatus, "pending");
});
