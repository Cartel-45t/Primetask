"use strict";

const DefaultDeposit = require("../models/Deposit");
const DefaultDarajaCallbackEvent = require("../models/DarajaCallbackEvent");
const {
  verifyAndCompleteDepositCallback: defaultVerify
} = require("./depositDarajaVerificationService");

const INTERVAL_MS = 60 * 1000;
const MINIMUM_AGE_MS = 60 * 1000;
const BATCH_SIZE = 25;

function createDepositRecoveryWorker({
  Deposit = DefaultDeposit,
  DarajaCallbackEvent = DefaultDarajaCallbackEvent,
  verifyAndCompleteDepositCallback = defaultVerify,
  logger = console,
  clock = Date.now
} = {}) {
  let timer = null;
  let running = false;

  async function processPendingDepositCallbacks() {
    if (running) {
      return { skipped: true, examined: 0, completed: 0, deferred: 0, errors: 0 };
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

      const deposits = await Deposit.find({
        status: "pending",
        paymentMode: "daraja",
        checkoutRequestId: { $type: "string" },
        updatedAt: { $lte: cutoff }
      })
        .sort({ updatedAt: 1 })
        .limit(BATCH_SIZE)
        .lean();

      for (const deposit of deposits) {
        summary.examined += 1;

        const callback = await DarajaCallbackEvent.findOne({
          checkoutRequestId: deposit.checkoutRequestId,
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
          await verifyAndCompleteDepositCallback({
            requestId: deposit.requestId,
            checkoutRequestId: deposit.checkoutRequestId,
            merchantRequestId: callback.merchantRequestId,
            resultCode: callback.resultCode,
            metadata: {
              amountKes: callback.callbackAmountKes,
              receipt: callback.callbackReceipt,
              phoneNumber: callback.callbackPhoneNumber
            },
            ipAddress: "background-recovery-worker"
          });

          await DarajaCallbackEvent.updateOne(
            {
              _id: callback._id,
              processingStatus: {
                $in: ["received", "reconciliation_required"]
              }
            },
            { $set: { processingStatus: "processed" } }
          );

          summary.completed += 1;

          logger.info(
            "Automatic deposit recovery completed:",
            deposit.requestId
          );
        } catch (error) {
          summary.errors += 1;

          logger.warn(
            "Automatic deposit recovery deferred:",
            deposit.requestId,
            String(error.message || "Verification failed")
          );

          try {
            await Promise.all([
              DarajaCallbackEvent.updateOne(
                { _id: callback._id },
                {
                  $set: {
                    processingStatus: "reconciliation_required"
                  }
                }
              ),
              Deposit.updateOne(
                { _id: deposit._id, status: "pending" },
                {
                  $set: {
                    resultDescription:
                      "Automatic verification is pending another safe retry: " +
                      String(error.message || "Verification failed").slice(0, 350)
                  }
                }
              )
            ]);
          } catch (persistenceError) {
            summary.errors += 1;
            logger.error(
              "Could not persist recovery failure:",
              persistenceError.message
            );
          }
        }
      }
    } catch (error) {
      summary.errors += 1;
      logger.error("Deposit recovery worker failed:", error.message);
    } finally {
      running = false;
    }

    return summary;
  }

  function startDepositRecoveryWorker() {
    if (timer) return;

    logger.info("Automatic deposit recovery worker started.");
    void processPendingDepositCallbacks();

    timer = setInterval(() => {
      void processPendingDepositCallbacks();
    }, INTERVAL_MS);

    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  function stopDepositRecoveryWorker() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    processPendingDepositCallbacks,
    startDepositRecoveryWorker,
    stopDepositRecoveryWorker
  };
}

const productionWorker = createDepositRecoveryWorker();

module.exports = {
  ...productionWorker,
  createDepositRecoveryWorker
};
