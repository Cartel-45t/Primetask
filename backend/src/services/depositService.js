const mongoose = require("mongoose");

const Deposit = require("../models/Deposit");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const MpesaReceiptClaim = require("../models/MpesaReceiptClaim");
const AdminAuditLog = require("../models/AdminAuditLog");

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
  phoneNumber,
  paymentMode = "daraja"
}) {
  const expectedAmountKes = calculateExpectedKes(amountCents);
  if (!["daraja", "simulation"].includes(paymentMode)) {
    throw new Error("Invalid deposit payment mode.");
  }

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
      paymentMode,
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
          existing.phoneNumber !== phoneNumber ||
          existing.paymentMode !== paymentMode
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
    mpesaReceipt,
    checkoutRequestId,
    evidenceSource,
    evidenceReference,
    claimedBy,
    auditReason,
    ipAddress
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

  if (
    typeof checkoutRequestId !== "string" ||
    !checkoutRequestId.trim() ||
    checkoutRequestId.trim().length > 150
  ) {
    throw new Error("A valid recorded checkout ID is required.");
  }

  const providerVerified =
    evidenceSource === "daraja_provider_confirmation";

  if (
    !providerVerified &&
    !["safaricom_portal", "safaricom_statement"].includes(evidenceSource)
  ) {
    throw new Error("Authoritative Safaricom evidence is required.");
  }

  if (
    typeof evidenceReference !== "string" ||
    !evidenceReference.trim() ||
    evidenceReference.trim().length > 150
  ) {
    throw new Error("A valid evidence reference is required.");
  }

  if (!providerVerified) {
    if (!mongoose.isValidObjectId(claimedBy)) {
      throw new Error("A valid verifying administrator is required.");
    }

    if (
      typeof auditReason !== "string" ||
      !auditReason.trim() ||
      auditReason.trim().length > 500
    ) {
      throw new Error("An audit reason is required.");
    }
  }

  const session = await mongoose.startSession();
  let outcome;

  try {
    await session.withTransaction(async () => {
      const deposit = await Deposit.findOne({ requestId }).session(session);

      if (!deposit) {
        throw new Error("Deposit not found.");
      }

      if (deposit.paymentMode !== "daraja") {
        throw new Error("Only Daraja deposits can be verified here.");
      }

      if (
        !deposit.checkoutRequestId ||
        deposit.checkoutRequestId !== checkoutRequestId.trim()
      ) {
        throw new Error("Recorded checkout ID does not match.");
      }

      if (deposit.expectedAmountKes !== amountKes) {
        throw new Error("Verified payment amount does not match the deposit.");
      }

      // An idempotent retry must match the receipt already credited.
      if (deposit.status === "completed") {
        if (deposit.mpesaReceipt !== receipt) {
          throw new Error("Completed deposit has a different receipt.");
        }
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

      await MpesaReceiptClaim.create(
        [{
          receipt,
          purpose: "deposit",
          referenceId: deposit.requestId,
          amountKes,
          claimedBy,
          evidenceSource,
          evidenceReference: evidenceReference.trim()
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

      if (!providerVerified) {
        await AdminAuditLog.create(
          [{
            adminId: claimedBy,
            targetUserId: deposit.userId,
            action: "deposit_payment_verified",
            reason: auditReason.trim(),
            before: {
              requestId: deposit.requestId,
              status: "pending",
              amountCents: deposit.amountCents,
              expectedAmountKes: deposit.expectedAmountKes
            },
            after: {
              requestId: deposit.requestId,
              status: "completed",
              amountCents: deposit.amountCents,
              amountKes,
              currency: "USD",
              mpesaReceipt: receipt,
              evidenceSource,
              evidenceReference: evidenceReference.trim()
            },
            ipAddress: typeof ipAddress === "string"
              ? ipAddress.slice(0, 100)
              : null
          }],
          { session }
        );
      }

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


/*
 * LOCAL DEVELOPMENT ONLY.
 * This path never creates or claims an M-Pesa receipt.
 * Deposit, wallet balance, and ledger commit atomically on success.
 */
async function completeSimulatedDeposit({ requestId, outcome }) {
  if (process.env.NODE_ENV !== "development" ||
      process.env.DEPOSIT_SIMULATION_ENABLED !== "true") {
    throw new Error("Deposit simulation is disabled.");
  }

  if (typeof requestId !== "string" || !requestId) {
    throw new Error("A valid deposit request ID is required.");
  }

  if (!["success", "failed"].includes(outcome)) {
    throw new Error("Simulation outcome must be success or failed.");
  }

  const session = await mongoose.startSession();
  let result;

  try {
    await session.withTransaction(async () => {
      const deposit = await Deposit.findOne({ requestId }).session(session);

      if (!deposit) {
        throw new Error("Deposit not found.");
      }

      if (deposit.paymentMode !== "simulation") {
        throw new Error("This deposit is not a simulated deposit.");
      }

      if (deposit.status === "completed") {
        result = {
          alreadyFinalized: true,
          alreadyCredited: true,
          requestId,
          amount: centsToUSD(deposit.amountCents),
          currency: "USD",
          status: "completed"
        };
        return;
      }

      if (deposit.status === "failed") {
        result = {
          alreadyFinalized: true,
          alreadyCredited: false,
          requestId,
          amount: centsToUSD(deposit.amountCents),
          currency: "USD",
          status: "failed"
        };
        return;
      }

      if (deposit.status !== "pending") {
        throw new Error("Deposit is not awaiting simulation.");
      }

      if (outcome === "failed") {
        const failed = await Deposit.findOneAndUpdate(
          {
            _id: deposit._id,
            status: "pending",
            paymentMode: "simulation"
          },
          {
            $set: {
              status: "failed",
              resultCode: 1,
              resultDescription: "Local simulated payment failure."
            }
          },
          { returnDocument: "after", session, runValidators: true }
        );

        if (!failed) {
          throw new Error("Deposit status changed; retry the simulation.");
        }

        result = {
          alreadyFinalized: false,
          alreadyCredited: false,
          requestId,
          amount: centsToUSD(deposit.amountCents),
          currency: "USD",
          status: "failed"
        };
        return;
      }

      const completedAt = new Date();
      const updated = await Deposit.findOneAndUpdate(
        {
          _id: deposit._id,
          status: "pending",
          paymentMode: "simulation"
        },
        {
          $set: {
            status: "completed",
            resultCode: 0,
            resultDescription: "Local simulated payment succeeded.",
            completedAt
          }
        },
        { returnDocument: "after", session, runValidators: true }
      );

      if (!updated) {
        throw new Error("Deposit status changed; retry the simulation.");
      }

      const wallet = await Wallet.findOneAndUpdate(
        { userId: deposit.userId, currency: "USD" },
        {
          $inc: { availableBalanceCents: deposit.amountCents },
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
          returnDocument: "after",
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
          reference: `SIM-${deposit.requestId}`,
          description: "Local simulated deposit; not an M-Pesa payment.",
          completedAt
        }],
        { session }
      );

      updated.walletTransactionId = transaction._id;
      await updated.save({ session });

      result = {
        alreadyFinalized: false,
        alreadyCredited: false,
        requestId,
        amount: centsToUSD(deposit.amountCents),
        currency: "USD",
        availableBalance: centsToUSD(wallet.availableBalanceCents),
        status: "completed",
        completedAt
      };
    });

    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = {
  calculateExpectedKes,
  createPendingDeposit,
  completeVerifiedDeposit,
  completeSimulatedDeposit
};
