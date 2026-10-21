"use strict";

require("dotenv").config();

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Deposit = require("../src/models/Deposit");
const Wallet = require("../src/models/Wallet");
const WalletTransaction = require("../src/models/WalletTransaction");

const {
  createPendingDeposit,
  completeSimulatedDeposit
} = require("../src/services/depositService");

const uri = process.env.PTW_TEST_MONGODB_URI;
const previousNodeEnv = process.env.NODE_ENV;
const previousSimulationFlag = process.env.DEPOSIT_SIMULATION_ENABLED;

const userId = new mongoose.Types.ObjectId();
const requestIds = [
  `DP-${crypto.randomUUID()}`,
  `DP-${crypto.randomUUID()}`,
  `DP-${crypto.randomUUID()}`
];
const idempotencyKeys = requestIds.map(() => crypto.randomUUID());

let connected = false;
let walletExistedBefore = false;

before(async () => {
  assert.ok(uri, "PTW_TEST_MONGODB_URI must be configured");

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

  await Deposit.init();
  await Wallet.init();
  await WalletTransaction.init();

  walletExistedBefore = Boolean(
    await Wallet.findOne({ userId }).lean()
  );

  assert.equal(
    walletExistedBefore,
    false,
    "Unexpected wallet exists for fresh test user ID"
  );

  process.env.NODE_ENV = "development";
  process.env.DEPOSIT_SIMULATION_ENABLED = "true";
});

after(async () => {
  if (connected) {
    const deposits = await Deposit.find({
      requestId: { $in: requestIds },
      userId
    }).select("_id").lean();

    const depositIds = deposits.map(deposit => deposit._id);

    if (depositIds.length) {
      await WalletTransaction.deleteMany({
        depositId: { $in: depositIds },
        userId
      });

      await Deposit.deleteMany({
        _id: { $in: depositIds },
        userId
      });
    }

    if (!walletExistedBefore) {
      await Wallet.deleteOne({ userId });
    }

    await mongoose.disconnect();
  }

  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;

  if (previousSimulationFlag === undefined) {
    delete process.env.DEPOSIT_SIMULATION_ENABLED;
  } else {
    process.env.DEPOSIT_SIMULATION_ENABLED = previousSimulationFlag;
  }
});

async function makeDeposit(index, paymentMode = "simulation") {
  const result = await createPendingDeposit({
    requestId: requestIds[index],
    idempotencyKey: idempotencyKeys[index],
    userId: userId.toString(),
    amountCents: 100,
    phoneNumber: "254700000001",
    paymentMode
  });

  assert.equal(result.created, true);
  return result.deposit;
}

test("successful simulation credits wallet and creates one ledger entry", async t => {
  if (!uri) return t.skip("Test database URI is not configured");

  const deposit = await makeDeposit(0);

  const result = await completeSimulatedDeposit({
    requestId: deposit.requestId,
    outcome: "success"
  });

  assert.equal(result.status, "completed");
  assert.equal(result.availableBalance, 1);

  const wallet = await Wallet.findOne({ userId }).lean();
  assert.equal(wallet.availableBalanceCents, 100);

  const ledger = await WalletTransaction.find({
    depositId: deposit._id
  }).lean();

  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].amountCents, 100);
  assert.equal(ledger[0].status, "completed");

  const completedDeposit = await Deposit.findById(deposit._id).lean();
  assert.equal(completedDeposit.status, "completed");
  assert.ok(completedDeposit.walletTransactionId);
});

test("repeating successful completion does not credit twice", async t => {
  if (!uri) return t.skip("Test database URI is not configured");

  const deposit = await makeDeposit(1);

  await completeSimulatedDeposit({
    requestId: deposit.requestId,
    outcome: "success"
  });

  const repeated = await completeSimulatedDeposit({
    requestId: deposit.requestId,
    outcome: "success"
  });

  assert.equal(repeated.alreadyFinalized, true);
  assert.equal(repeated.alreadyCredited, true);

  const wallet = await Wallet.findOne({ userId }).lean();
  assert.equal(wallet.availableBalanceCents, 200);

  const ledgerCount = await WalletTransaction.countDocuments({
    depositId: deposit._id
  });
  assert.equal(ledgerCount, 1);
});

test("failed simulation does not credit wallet or create ledger", async t => {
  if (!uri) return t.skip("Test database URI is not configured");

  const deposit = await makeDeposit(2);

  const result = await completeSimulatedDeposit({
    requestId: deposit.requestId,
    outcome: "failed"
  });

  assert.equal(result.status, "failed");

  const wallet = await Wallet.findOne({ userId }).lean();
  assert.equal(wallet.availableBalanceCents, 200);

  const ledgerCount = await WalletTransaction.countDocuments({
    depositId: deposit._id
  });
  assert.equal(ledgerCount, 0);
});

test("Daraja deposit cannot be completed through simulation", async t => {
  if (!uri) return t.skip("Test database URI is not configured");

  const requestId = `DP-${crypto.randomUUID()}`;
  requestIds.push(requestId);
  idempotencyKeys.push(crypto.randomUUID());

  const result = await createPendingDeposit({
    requestId,
    idempotencyKey: idempotencyKeys[idempotencyKeys.length - 1],
    userId: userId.toString(),
    amountCents: 100,
    phoneNumber: "254700000001",
    paymentMode: "daraja"
  });

  try {
    await assert.rejects(
      completeSimulatedDeposit({
        requestId,
        outcome: "success"
      }),
      /not a simulated deposit/
    );

    const deposit = await Deposit.findById(result.deposit._id).lean();
    assert.equal(deposit.status, "pending");

    const ledgerCount = await WalletTransaction.countDocuments({
      depositId: deposit._id
    });
    assert.equal(ledgerCount, 0);
  } finally {
    // The shared after hook removes this test's deposit and related records.
  }
});
