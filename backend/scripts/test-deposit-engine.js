require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");
const { randomUUID } = require("crypto");

const User = require("../src/models/User");
const Wallet = require("../src/models/Wallet");
const Deposit = require("../src/models/Deposit");
const WalletTransaction = require("../src/models/WalletTransaction");

const {
  createPendingDeposit,
  completeVerifiedDeposit
} = require("../src/services/depositService");

function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function main() {
  const username = String(process.env.DEPOSIT_TEST_USERNAME || "")
    .trim()
    .toLowerCase();

  if (!username) {
    throw new Error(
      "Set DEPOSIT_TEST_USERNAME to a dedicated test user's username."
    );
  }

  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing from .env.");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  let user;
  let originalWallet;
  const createdDepositIds = [];
  const createdRequestIds = [];
  let cleanupBalanceCents = null;

  try {
    user = await User.findOne({ username })
      .select("_id username role")
      .lean();

    if (!user) {
      throw new Error("Dedicated test user was not found.");
    }

    if (user.role !== "user") {
      throw new Error("Refusing to test with an admin or founder account.");
    }

    originalWallet = await Wallet.findOne({ userId: user._id }).lean();

    if (originalWallet && (
      originalWallet.availableBalanceCents !== 0 ||
      originalWallet.pendingEarningsCents !== 0 ||
      originalWallet.totalEarningsCents !== 0 ||
      originalWallet.totalWithdrawalsCents !== 0
    )) {
      throw new Error(
        "Wallet is not empty. Use an isolated test account with no financial activity."
      );
    }

    // Refuse to run if this account already has deposit records.
    const existingDeposits = await Deposit.countDocuments({
      userId: user._id
    });

    if (existingDeposits !== 0) {
      throw new Error(
        "Test account already has deposit records. Use a fresh, isolated test account."
      );
    }

    const runId = randomUUID();
    const phoneNumber = "254712345678";
    const amountCents = 100;
    const expectedKes = 130;

    const firstRequestId = `DP-${randomUUID()}`;
    const firstReceipt =
      `T${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`;

    const secondRequestId = `DP-${randomUUID()}`;

    console.log("Test user:", user.username);
    console.log("Mode: local service test; no Daraja requests.");

    // Test 1: Creating a pending deposit does not credit the wallet.
    const first = await createPendingDeposit({
      requestId: firstRequestId,
      idempotencyKey: `test-${runId}-first`,
      userId: user._id,
      amountCents,
      phoneNumber
    });

    assert(first.created, "First pending deposit should be newly created.");

    createdDepositIds.push(first.deposit._id);
    createdRequestIds.push(firstRequestId);

    let wallet = await Wallet.findOne({ userId: user._id }).lean();

    assert(
      !wallet || wallet.availableBalanceCents === 0,
      "Pending deposit must not credit the wallet."
    );

    console.log("PASS: pending deposit did not credit the wallet.");

    // Test 2: Completing a correctly verified payment credits exactly $1.
    const completed = await completeVerifiedDeposit({
      requestId: firstRequestId,
      resultCode: 0,
      amountKes: expectedKes,
      mpesaReceipt: firstReceipt
    });

    assert(!completed.alreadyCredited, "First credit must be applied.");
    assert(completed.amount === 1, "Expected a $1.00 deposit.");

    wallet = await Wallet.findOne({ userId: user._id }).lean();

    assert(
      wallet.availableBalanceCents === 100,
      "Wallet should contain exactly 100 cents after the first deposit."
    );

    const firstLedger = await WalletTransaction.find({
      depositId: first.deposit._id
    }).lean();

    assert(
      firstLedger.length === 1,
      "Exactly one ledger entry should exist for the first deposit."
    );

    console.log("PASS: verified deposit credited exactly $1.00.");

    // Test 3: Replaying a completed deposit must not credit it twice.
    const replay = await completeVerifiedDeposit({
      requestId: firstRequestId,
      resultCode: 0,
      amountKes: expectedKes,
      mpesaReceipt: firstReceipt
    });

    assert(replay.alreadyCredited, "Replay should report an existing credit.");

    wallet = await Wallet.findOne({ userId: user._id }).lean();

    const replayLedger = await WalletTransaction.find({
      depositId: first.deposit._id
    }).lean();

    assert(
      wallet.availableBalanceCents === 100,
      "Replay must not change the wallet balance."
    );

    assert(
      replayLedger.length === 1,
      "Replay must not create another ledger entry."
    );

    console.log("PASS: replay did not double-credit.");

    // Test 4: Use a DIFFERENT pending deposit for amount-mismatch validation.
    const second = await createPendingDeposit({
      requestId: secondRequestId,
      idempotencyKey: `test-${runId}-second`,
      userId: user._id,
      amountCents,
      phoneNumber
    });

    assert(second.created, "Second pending deposit should be newly created.");

    createdDepositIds.push(second.deposit._id);
    createdRequestIds.push(secondRequestId);

    let mismatchRejected = false;

    try {
      await completeVerifiedDeposit({
        requestId: secondRequestId,
        resultCode: 0,
        amountKes: expectedKes + 1,
        mpesaReceipt:
          `M${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`
      });
    } catch (error) {
      mismatchRejected =
        error.message === "Verified payment amount does not match the deposit.";
    }

    assert(
      mismatchRejected,
      "Incorrect KSh amount must be rejected by the amount-mismatch check."
    );

    const secondAfterMismatch = await Deposit.findOne({
      _id: second.deposit._id,
      userId: user._id
    }).lean();

    assert(
      secondAfterMismatch.status === "pending",
      "Mismatched payment must leave the second deposit pending."
    );

    wallet = await Wallet.findOne({ userId: user._id }).lean();

    assert(
      wallet.availableBalanceCents === 100,
      "Mismatched payment must not credit the wallet."
    );

    const secondLedger = await WalletTransaction.find({
      depositId: second.deposit._id
    }).lean();

    assert(
      secondLedger.length === 0,
      "Mismatched payment must not create a ledger entry."
    );

    console.log(
      "PASS: mismatched KSh amount rejected; deposit stayed pending."
    );

    console.log("\nALL DEPOSIT ENGINE TESTS PASSED.");
  } finally {
    // Delete only the deposits and ledger rows created by this run.
    if (user) {
      for (const depositId of createdDepositIds) {
        await WalletTransaction.deleteMany({
          userId: user._id,
          depositId
        });

        await Deposit.deleteOne({
          _id: depositId,
          userId: user._id
        });
      }

      // Restore the test balance only if the observed balance is exactly
      // the amount this test produced. Do not overwrite unexpected changes.
      if (createdDepositIds.length > 0) {
        const remainingDeposits = await Deposit.countDocuments({
          userId: user._id,
          _id: { $in: createdDepositIds }
        });

        if (remainingDeposits === 0) {
          const currentWallet = await Wallet.findOne({
            userId: user._id
          }).lean();

          if (
            currentWallet &&
            currentWallet.availableBalanceCents === 100 &&
            currentWallet.pendingEarningsCents === 0 &&
            currentWallet.totalEarningsCents === 0 &&
            currentWallet.totalWithdrawalsCents === 0
          ) {
            if (originalWallet) {
              await Wallet.updateOne(
                {
                  _id: originalWallet._id,
                  availableBalanceCents: 100,
                  pendingEarningsCents: 0,
                  totalEarningsCents: 0,
                  totalWithdrawalsCents: 0
                },
                {
                  $set: {
                    availableBalanceCents:
                      originalWallet.availableBalanceCents
                  }
                }
              );
            } else {
              await Wallet.deleteOne({
                _id: currentWallet._id,
                userId: user._id,
                availableBalanceCents: 100,
                pendingEarningsCents: 0,
                totalEarningsCents: 0,
                totalWithdrawalsCents: 0
              });
            }
          } else if (currentWallet) {
            console.error(
              "CLEANUP WARNING: Wallet differs from the expected test balance. " +
              "It was left untouched for manual inspection."
            );
          }
        }
      }
    }

    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error("Deposit test failed:", error.message);
  process.exitCode = 1;
});
