"use strict";

const MinutePurchase = require("../models/TranscriptionMinutePurchase");
const DarajaCallbackEvent = require("../models/DarajaCallbackEvent");
const {
  verifyAndCreditTranscriptionMinutePurchase
} = require("./transcriptionMinuteDarajaVerificationService");

const INTERVAL_MS = 60 * 1000;
const MINIMUM_AGE_MS = 60 * 1000;
const BATCH_SIZE = 25;

function createTranscriptionMinuteRecoveryWorker({
  Purchase = MinutePurchase,
  CallbackEvent = DarajaCallbackEvent,
  verify = verifyAndCreditTranscriptionMinutePurchase,
  logger = console,
  clock = Date.now
} = {}) {
  let timer = null;
  let running = false;

  async function processPendingMinuteCallbacks() {
    if (running) {
      return {
        skipped: true,
        examined: 0,
        completed: 0,
        deferred: 0,
        errors: 0
      };
    }

    running = true;
    const summary = {
      examined: 0,
      completed: 0,
      deferred: 0,
      errors: 0
    };

    try {
      const cutoff = new Date(clock() - MINIMUM_AGE_MS);

      const purchases = await Purchase.find({
        paymentStatus: { $in: ["pending", "verification_required"] },
        checkoutRequestId: { $type: "string" },
        merchantRequestId: { $type: "string" },
        updatedAt: { $lte: cutoff }
      })
        .sort({ updatedAt: 1 })
        .limit(BATCH_SIZE)
        .lean();

      for (const purchase of purchases) {
        summary.examined += 1;

        const callback = await CallbackEvent.findOne({
          checkoutRequestId: purchase.checkoutRequestId,
          merchantRequestId: purchase.merchantRequestId,
          resultCode: 0,
          callbackAmountKes: { $type: "number" },
          callbackReceipt: { $type: "string" },
          callbackPhoneNumber: { $type: "string" },
          processingStatus: {
            $in: ["received", "reconciliation_required"]
          }
        })
          .sort({ createdAt: -1 })
          .lean();

        if (!callback) {
          summary.deferred += 1;
          continue;
        }

        try {
          const result = await verify({
            purchaseId: purchase._id,
            checkoutRequestId: purchase.checkoutRequestId,
            merchantRequestId: callback.merchantRequestId,
            resultCode: callback.resultCode,
            metadata: {
              amountKes: callback.callbackAmountKes,
              receipt: callback.callbackReceipt,
              phoneNumber: callback.callbackPhoneNumber
            }
          });

          if (!result?.verified) {
            await Promise.all([
              CallbackEvent.updateOne(
                { _id: callback._id },
                { $set: { processingStatus: "reconciliation_required" } }
              ),
              Purchase.updateOne(
                {
                  _id: purchase._id,
                  paymentStatus: {
                    $in: ["pending", "verification_required"]
                  }
                },
                {
                  $set: {
                    paymentStatus: "verification_required",
                    failureCode: String(
                      result?.reason || "PROVIDER_CONFIRMATION_INCOMPLETE"
                    ).slice(0, 100),
                    failureDescription:
                      "Automatic M-Pesa verification has not completed. The purchase remains unresolved and will be retried."
                  }
                }
              )
            ]);

            summary.deferred += 1;
            continue;
          }

          await CallbackEvent.updateOne(
            { _id: callback._id },
            { $set: { processingStatus: "processed" } }
          );

          summary.completed += 1;
          logger.info(
            "Transcription minute purchase recovery completed:",
            String(purchase._id)
          );
        } catch (error) {
          summary.errors += 1;

          logger.warn(
            "Transcription minute purchase recovery deferred:",
            String(purchase._id),
            String(error?.message || "Verification failed")
          );

          try {
            await CallbackEvent.updateOne(
              { _id: callback._id },
              { $set: { processingStatus: "reconciliation_required" } }
            );
          } catch (persistenceError) {
            summary.errors += 1;
            logger.error(
              "Could not persist minute recovery status:",
              persistenceError.message
            );
          }
        }
      }
    } catch (error) {
      summary.errors += 1;
      logger.error(
        "Transcription minute recovery worker failed:",
        error.message
      );
    } finally {
      running = false;
    }

    return summary;
  }

  function startTranscriptionMinuteRecoveryWorker() {
    if (timer) return;

    logger.info("Transcription minute recovery worker started.");
    void processPendingMinuteCallbacks();

    timer = setInterval(() => {
      void processPendingMinuteCallbacks();
    }, INTERVAL_MS);

    if (typeof timer.unref === "function") timer.unref();
  }

  function stopTranscriptionMinuteRecoveryWorker() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    processPendingMinuteCallbacks,
    startTranscriptionMinuteRecoveryWorker,
    stopTranscriptionMinuteRecoveryWorker
  };
}

const productionWorker = createTranscriptionMinuteRecoveryWorker();

module.exports = {
  ...productionWorker,
  createTranscriptionMinuteRecoveryWorker
};
