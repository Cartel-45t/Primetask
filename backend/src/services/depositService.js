const mongoose = require("mongoose");

const Deposit = require("../models/Deposit");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const MpesaReceiptClaim = require("../models/MpesaReceiptClaim");

const KES_PER_USD = 130;

function centsToUSD(cents) {
  return Number((cents / 100).toFixed(2));
}

/*
 * Amounts are stored in integer USD cents.
 * At KSh130/USD, every $0.10 converts to a whole KSh amount.
 */
function calculateExpectedKes(amountCents) {
  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents < 10 ||
    amountCents % 10 !== 0
  ) {
    throw new Error(
      "Deposit amount must be at least $0.10 and in $0.10 increments."
    );
  }

  const amountKes = (amountCents * KES_PER_USD) / 100;

  if (!Number.isSafeInteger(amountKes)) {
    throw new Error("Deposit converts to an invalid KSh amount.");
  }

  return amountKes;
}

/*
 * Creates a pending deposit only.
 * This function does not initiate an STK request or credit a wallet.
 */
async function createPendingDeposit({
  requestId,
  idempotencyKey,
  userId,
  amountCents,
  phoneNumber
}) {
  const expectedAmountKes = calculateExpectedKes(amountCents);

  if (!mongoose.isValidObjectId(userId)) {
    throw new Error("Invalid deposit user.");
  }

  if (
    typeof requestId !== "string" ||
    !/^DP-[0-9a-f-]{36}$/i.test(requestId)
  ) {
    throw new Error("Invalid deposit request ID.");
  }

  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.length < 8 ||
    idempotencyKey.length > 100
  ) {
    throw new Error("Invalid deposit idempotency key.");
  }

  if (
    typeof phoneNumber !== "string" ||
    !/^254[17]\d{8}$/.test(phoneNumber)
  ) {
    throw new Error("Invalid normalized Kenyan phone number.");
  }

  try {
    const deposit = await Deposit.create({
      requestId,
      idempotencyKey,
      userId,
      amountCents,
      currency: "USD",
      expectedAmountKes,
      phoneNumber,
      status: "pending"
    });

    return {
      created: true,
      deposit: deposit.toObject()
    };
  } catch (error) {
    if (error.code === 11000) {
      const existing = await Deposit.findOne({
        userId,
        idempotencyKey
      }).lean();

      if (existing) {
        if (
          existing.amountCents !== amountCents ||
          existing.phoneNumber !== phoneNumber
        ) {
          throw new Error(
            "Idempotency key was already used with different deposit details."
          );
        }

        return {
          created: false,
          deposit: existing
        };
      }
    }

    throw error;
  }
}

/*
 * Call ONLY after the payment has been independently verified with Daraja.
 *
 * verifiedPayment must contain:
 * {
 *   requestId,
 *   resultCode: 0,
 *   amountKes: whole KSh,
 *   mpesaReceipt: verified receipt
 * }
 *
 * Deposit completion, wallet credit, and ledger creation commit together.
 */
async function completeVerifiedDeposit(verifiedPayment) {
  const {
    requestId,
    resultCode,
    amountKes,
    mpesaReceipt
  } = verifiedPayment || {};

  if (
    typeof requestId !== "string" ||
    !requestId
  ) {
    throw new Error("A valid deposit request ID is required.");
  }

  if (resultCode !== 0) {
    throw new Error("Payment has not been verified as successful.");
  }

  if (!Number.isSafeInteger(amountKes) || amountKes < 1) {
    throw new Error("Verified payment amount must be whole KSh.");
  }

  const receipt = String(mpesaReceipt || "").trim().toUpperCase();

  if (!/^[A-Z0-9]{6,30}$/.test(receipt)) {
    throw new Error("A valid verified M-Pesa receipt is required.");
  }

  const session = await mongoose.startSession();
  let outcome;

  try {
    await session.withTransaction(async () => {
      const deposit = await Deposit.findOne({ requestId }).session(session);

      if (!deposit) {
        throw new Error("Deposit not found.");
      }

      // Repeated callbacks cannot credit a completed deposit again.
      if (deposit.status === "completed") {
        outcome = {
          alreadyCredited: true,
          requestId: deposit.requestId,
          amount: centsToUSD(deposit.amountCents),
          currency: "USD"
        };
        return;
      }

      if (deposit.status !== "pending") {
        throw new Error("Deposit is not awaiting payment.");
      }

      if (deposit.expectedAmountKes !== amountKes) {
        throw new Error("Verified payment amount does not match the deposit.");
      }

      await MpesaReceiptClaim.create(
        [{
          receipt,
          purpose: "deposit",
          referenceId: deposit.requestId,
          amountKes,
          evidenceSource: "deposit_completion_service"
        }],
        { session }
      );

      const updated = await Deposit.findOneAndUpdate(
        {
          _id: deposit._id,
          status: "pending",
          expectedAmountKes: amountKes
        },
        {
          $set: {
            status: "completed",
            resultCode: 0,
            mpesaReceipt: receipt,
            completedAt: new Date()
          }
        },
        {
          returnDocument: 'after',
          runValidators: true,
          session
        }
      );

      if (!updated) {
        throw new Error("Deposit status changed; retry verification.");
      }

      const wallet = await Wallet.findOneAndUpdate(
        {
          userId: deposit.userId,
          currency: "USD"
        },
        {
          $inc: {
            availableBalanceCents: deposit.amountCents
          },
          $setOnInsert: {
            userId: deposit.userId,
            currency: "USD",
            pendingEarningsCents: 0,
            totalEarningsCents: 0,
            totalWithdrawalsCents: 0
          }
        },
        {
          upsert: true,
          returnDocument: 'after',
          setDefaultsOnInsert: true,
          runValidators: true,
          session
        }
      );

      const [transaction] = await WalletTransaction.create(
        [{
          depositId: deposit._id,
          userId: deposit.userId,
          type: "deposit",
          amountCents: deposit.amountCents,
          currency: "USD",
          status: "completed",
          reference: `DP-${deposit.requestId}`,
          description: `Verified M-Pesa deposit ${receipt}`,
          completedAt: updated.completedAt
        }],
        { session }
      );

      updated.walletTransactionId = transaction._id;
      await updated.save({ session });

      outcome = {
        alreadyCredited: false,
        requestId: deposit.requestId,
        amount: centsToUSD(deposit.amountCents),
        currency: "USD",
        availableBalance: centsToUSD(wallet.availableBalanceCents),
        receipt,
        completedAt: updated.completedAt
      };
    });

    return outcome;
  } finally {
    await session.endSession();
  }
}

module.exports = {
  calculateExpectedKes,
  createPendingDeposit,
  completeVerifiedDeposit
};
