"use strict";

const DefaultPurchase = require("../models/NotesPointsPurchase");
const DefaultCallbackEvent = require("../models/DarajaCallbackEvent");
const { queryStkPush: defaultQueryProvider } = require("./darajaService");
const {
  verifyAndCreditNotesPointsPurchase: defaultVerify
} = require("./notesPointsDarajaVerificationService");

const INTERVAL_MS = 60 * 1000;
const MINIMUM_AGE_MS = 2 * 60 * 1000;
const BATCH_SIZE = 25;
const TERMINAL_CANCEL_CODE = 1032;

function makeQuery(value) {
  return {
    sort() { return this; },
    limit() { return this; },
    lean: async () => value
  };
}

function createNotesPointsRecoveryWorker({
  Purchase = DefaultPurchase,
  DarajaCallbackEvent = DefaultCallbackEvent,
  queryProvider = defaultQueryProvider,
  verify = defaultVerify,
  logger = console,
  clock = Date.now
} = {}) {
  let timer = null;
  let running = false;

  async function updateUnresolved(purchase, values) {
    return Purchase.updateOne(
      {
        _id: purchase._id,
        checkoutRequestId: purchase.checkoutRequestId,
        paymentStatus: { $in: ["pending", "verification_required"] },
        hasUnresolvedPayment: true
      },
      {
        $set: {
          ...values,
          lastReconciledAt: new Date(clock())
        }
      }
    );
  }

  async function failPurchase(purchase, code, description) {
    const isCancellation = Number(code) === TERMINAL_CANCEL_CODE;

    await updateUnresolved(purchase, {
      paymentStatus: isCancellation ? "cancelled" : "failed",
      hasUnresolvedPayment: false,
      failureCode: String(code).slice(0, 100),
      failureDescription: String(
        description ||
        (isCancellation
          ? "Safaricom confirmed payment cancellation."
          : "Safaricom confirmed that the payment was unsuccessful.")
      ).slice(0, 500)
    });
  }

  async function processPendingPurchases() {
    if (running) {
      return {
        skipped: true,
        examined: 0,
        completed: 0,
        cancelled: 0,
        failed: 0,
        deferred: 0,
        errors: 0
      };
    }

    running = true;

    const summary = {
      examined: 0,
      completed: 0,
      cancelled: 0,
      failed: 0,
      deferred: 0,
      errors: 0
    };

    try {
      const cutoff = new Date(clock() - MINIMUM_AGE_MS);

      const purchases = await Purchase.find({
        paymentStatus: { $in: ["pending", "verification_required"] },
        hasUnresolvedPayment: true,
        checkoutRequestId: { $type: "string" },
        merchantRequestId: { $type: "string" },
        $or: [
          { stkInitiatedAt: { $type: "date", $lte: cutoff } },
          { stkInitiatedAt: null, createdAt: { $lte: cutoff } }
        ]
      })
        .sort({ stkInitiatedAt: 1, createdAt: 1 })
        .limit(BATCH_SIZE)
        .lean();

      for (const purchase of purchases) {
        summary.examined += 1;

        try {
          const callback = await DarajaCallbackEvent.findOne({
            checkoutRequestId: purchase.checkoutRequestId,
            merchantRequestId: purchase.merchantRequestId,
            processingStatus: {
              $in: ["received", "reconciliation_required"]
            }
          })
            .sort({ createdAt: -1 })
            .lean();

          if (
            callback &&
            Number.isInteger(Number(callback.resultCode)) &&
            Number(callback.resultCode) !== 0
          ) {
            const resultCode = Number(callback.resultCode);
            const isCancellation = resultCode === TERMINAL_CANCEL_CODE;

            await failPurchase(
              purchase,
              resultCode,
              callback.resultDescription
            );

            await DarajaCallbackEvent.updateOne(
              { _id: callback._id },
              { $set: { processingStatus: "processed" } }
            );

            if (isCancellation) {
              summary.cancelled += 1;
            } else {
              summary.failed += 1;
            }
            continue;
          }

          const hasCompleteSuccessEvidence =
            callback &&
            Number(callback.resultCode) === 0 &&
            Number.isSafeInteger(callback.callbackAmountKes) &&
            callback.callbackAmountKes > 0 &&
            typeof callback.callbackReceipt === "string" &&
            callback.callbackReceipt.length > 0 &&
            typeof callback.callbackPhoneNumber === "string" &&
            callback.callbackPhoneNumber.length > 0;

          if (hasCompleteSuccessEvidence) {
            const verification = await verify({
              purchaseId: purchase._id,
              checkoutRequestId: purchase.checkoutRequestId,
              merchantRequestId: callback.merchantRequestId,
              resultCode: 0,
              metadata: {
                amountKes: callback.callbackAmountKes,
                receipt: callback.callbackReceipt,
                phoneNumber: callback.callbackPhoneNumber
              }
            });

            if (verification?.verified) {
              await DarajaCallbackEvent.updateOne(
                { _id: callback._id },
                { $set: { processingStatus: "processed" } }
              );

              summary.completed += 1;
              logger.info(
                "Notes Points recovery verified:",
                String(purchase._id)
              );
              continue;
            }

            await DarajaCallbackEvent.updateOne(
              { _id: callback._id },
              { $set: { processingStatus: "reconciliation_required" } }
            );

            await updateUnresolved(purchase, {
              paymentStatus: "verification_required",
              failureCode: String(
                verification?.reason || "VERIFICATION_INCOMPLETE"
              ).slice(0, 100),
              failureDescription:
                "Callback evidence could not be independently verified. No Points were credited."
            });

            summary.deferred += 1;
            continue;
          }

          // A callback with incomplete evidence is not enough to credit.
          // Query the existing checkout; never send another STK Push.
          const providerResult = await queryProvider({
            checkoutRequestId: purchase.checkoutRequestId
          });

          let failureCode = "PROVIDER_CONFIRMATION_INCOMPLETE";
          let failureDescription =
            "Safaricom has not supplied enough evidence to complete this payment. The purchase remains unresolved.";

          if (
            providerResult?.mode === "live" &&
            String(providerResult?.responseCode) === "0" &&
            String(providerResult?.resultCode) === "0"
          ) {
            failureCode = "CALLBACK_EVIDENCE_MISSING";
            failureDescription =
              "Safaricom query indicates success, but callback receipt, amount and phone evidence are missing. No Points were credited; the purchase remains unresolved.";
          } else if (providerResult?.mode === "disabled") {
            failureCode = "PROVIDER_QUERY_DISABLED";
            failureDescription =
              "Safaricom query is disabled. The purchase remains unresolved.";
          } else if (
            providerResult?.mode === "live" &&
            String(providerResult?.responseCode) === "0" &&
            providerResult?.resultCode !== null &&
            providerResult?.resultCode !== undefined
          ) {
            failureCode = `UNCLASSIFIED_RESULT_CODE_${providerResult.resultCode}`;
            failureDescription =
              "Safaricom returned an unclassified result. The purchase remains unresolved pending confirmation.";
          }

          await updateUnresolved(purchase, {
            paymentStatus: "verification_required",
            failureCode,
            failureDescription
          });

          if (callback) {
            await DarajaCallbackEvent.updateOne(
              { _id: callback._id },
              { $set: { processingStatus: "reconciliation_required" } }
            );
          }

          summary.deferred += 1;
        } catch (error) {
          summary.errors += 1;

          logger.warn(
            "Notes Points recovery deferred:",
            String(purchase._id),
            String(error.message || "Recovery failed")
          );

          try {
            await updateUnresolved(purchase, {
              paymentStatus: "verification_required",
              failureCode: "RECOVERY_RETRY_REQUIRED",
              failureDescription:
                "Automatic payment reconciliation encountered an error. The purchase remains unresolved."
            });
          } catch (persistenceError) {
            summary.errors += 1;
            logger.error(
              "Could not persist Notes Points recovery state:",
              persistenceError.message
            );
          }
        }
      }
    } catch (error) {
      summary.errors += 1;
      logger.error("Notes Points recovery worker failed:", error.message);
    } finally {
      running = false;
    }

    return summary;
  }

  function startNotesPointsRecoveryWorker() {
    if (timer) return;

    logger.info("Notes Points recovery worker started.");
    void processPendingPurchases();

    timer = setInterval(() => {
      void processPendingPurchases();
    }, INTERVAL_MS);

    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  function stopNotesPointsRecoveryWorker() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    processPendingPurchases,
    startNotesPointsRecoveryWorker,
    stopNotesPointsRecoveryWorker
  };
}

const productionWorker = createNotesPointsRecoveryWorker();

module.exports = {
  ...productionWorker,
  createNotesPointsRecoveryWorker,
  INTERVAL_MS,
  MINIMUM_AGE_MS,
  BATCH_SIZE
};
