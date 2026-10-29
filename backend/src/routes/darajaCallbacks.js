const express = require("express");
const { createHash } = require("crypto");
const Deposit = require("../models/Deposit");
const MembershipPurchase = require("../models/MembershipPurchase");
const MinutePurchase = require("../models/TranscriptionMinutePurchase");
const NotesPointsPurchase = require("../models/NotesPointsPurchase");
const DarajaCallbackEvent = require("../models/DarajaCallbackEvent");
const { verifyAndFulfilMembershipCallback } = require("../services/membershipDarajaVerificationService");
const {
  verifyAndCompleteDepositCallback
} = require("../services/depositDarajaVerificationService");
// Callback data is untrusted and must never independently authorize a wallet credit.
const {
  verifyAndCreditTranscriptionMinutePurchase
} = require("../services/transcriptionMinuteDarajaVerificationService");
const {
  verifyAndCreditNotesPointsPurchase
} = require("../services/notesPointsDarajaVerificationService");

const router = express.Router();

function boundedString(value, maxLength) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
    ? value
    : null;
}

function makeEventKey(data) {
  return createHash("sha256")
    .update(JSON.stringify(data))
    .digest("hex");
}

function extractCallbackMetadata(callback) {
  const items = callback?.CallbackMetadata?.Item;

  if (!Array.isArray(items)) {
    return {
      amountKes: null,
      receipt: null,
      phoneNumber: null,
      transactionDate: null
    };
  }

  const values = new Map();

  for (const item of items) {
    if (
      item &&
      typeof item.Name === "string" &&
      Object.prototype.hasOwnProperty.call(item, "Value")
    ) {
      values.set(item.Name, item.Value);
    }
  }

  const rawAmount = values.get("Amount");
  const amountKes =
    typeof rawAmount === "number" &&
    Number.isSafeInteger(rawAmount) &&
    rawAmount > 0
      ? rawAmount
      : null;

  const rawPhone = values.get("PhoneNumber");
  const phoneNumber =
    typeof rawPhone === "number" &&
    Number.isSafeInteger(rawPhone) &&
    rawPhone > 0
      ? String(rawPhone)
      : null;

  const rawDate = values.get("TransactionDate");
  const transactionDate =
    (typeof rawDate === "number" || typeof rawDate === "string") &&
    /^\d{14}$/.test(String(rawDate))
      ? String(rawDate)
      : null;

  return {
    amountKes,
    receipt: boundedString(values.get("MpesaReceiptNumber"), 30),
    phoneNumber,
    transactionDate
  };
}

router.post("/stk", async (req, res) => {
  const callback = req.body?.Body?.stkCallback;
  const checkoutRequestId = boundedString(
    callback?.CheckoutRequestID,
    150
  );

  if (!callback || !checkoutRequestId) {
    return res.status(400).json({
      ResultCode: 1,
      ResultDesc: "Invalid callback payload"
    });
  }

  const merchantRequestId = boundedString(
    callback.MerchantRequestID,
    150
  );

  const resultCode = Number.isInteger(callback.ResultCode)
    ? callback.ResultCode
    : null;

  const resultDescription =
    typeof callback.ResultDesc === "string"
      ? callback.ResultDesc.slice(0, 500)
      : "";

  const metadata = extractCallbackMetadata(callback);

  // Metadata is untrusted callback evidence, not payment verification.
  const eventData = {
    checkoutRequestId,
    merchantRequestId,
    resultCode,
    resultDescription,
    callbackAmountKes: metadata.amountKes,
    callbackReceipt: metadata.receipt
      ? metadata.receipt.toUpperCase()
      : null,
    callbackPhoneNumber: metadata.phoneNumber,
    transactionDate: metadata.transactionDate
  };

  const eventKey = makeEventKey(eventData);

  try {
    try {
      await DarajaCallbackEvent.create({
        eventKey,
        ...eventData,
        processingStatus: "received"
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;

      const existing = await DarajaCallbackEvent.findOne({
        eventKey
      });

      if (!existing) throw error;
    }

    const deposit = await Deposit.findOne({
      checkoutRequestId
    });

    if (!deposit) {
      // Membership callbacks require callback metadata AND an independent
      // live Safaricom query before payment can be verified.
      const membershipPurchase = await MembershipPurchase.findOne({
        checkoutRequestId
      });

      if (membershipPurchase) {
        let verification;

        try {
          verification = await verifyAndFulfilMembershipCallback({
            purchaseId: membershipPurchase._id,
            checkoutRequestId,
            merchantRequestId,
            resultCode,
            metadata
          });
        } catch (verificationError) {
          console.error(
            "Membership payment verification failed safely:",
            verificationError.message
          );
          verification = {
            verified: false,
            reason: verificationError.code || "VERIFICATION_ERROR"
          };
        }

        if (verification.verified) {
          await DarajaCallbackEvent.updateOne(
            { eventKey },
            { $set: { processingStatus: "processed" } }
          );

          console.info(
            "Membership payment verified:",
            String(membershipPurchase._id),
            "fulfilled:",
            verification.fulfilled === true
          );

          return res.status(200).json({
            ResultCode: 0,
            ResultDesc: verification.fulfilled
              ? "Membership payment verified and fulfilment completed"
              : "Payment verified; membership fulfilment requires recovery"
          });
        }

        await Promise.all([
          DarajaCallbackEvent.updateOne(
            { eventKey },
            { $set: { processingStatus: "reconciliation_required" } }
          ),
          MembershipPurchase.updateOne(
            {
              _id: membershipPurchase._id,
              paymentStatus: "pending"
            },
            {
              $set: {
                paymentStatus: "verification_required",
                failureCode: verification.reason || "CALLBACK_REQUIRES_RECONCILIATION",
                failureDescription:
                  "Automatic payment verification could not safely confirm this purchase. Manual reconciliation is required."
              }
            }
          )
        ]);

        console.info(
          "Membership callback requires reconciliation:",
          String(membershipPurchase._id),
          verification.reason || "UNCONFIRMED"
        );

        return res.status(200).json({
          ResultCode: 0,
          ResultDesc: "Callback stored; payment requires reconciliation"
        });
      }

      // The event is persisted before this point. Callback data alone
      // never credits minutes; the service independently queries Daraja.
      const minutePurchase = await MinutePurchase.findOne({
        checkoutRequestId
      });

      if (minutePurchase) {
        let verification = {
          verified: false,
          reason: resultCode === 0
            ? "CALLBACK_REQUIRES_RECONCILIATION"
            : "PAYMENT_NOT_SUCCESSFUL"
        };

        if (resultCode === 0) {
          try {
            verification = await verifyAndCreditTranscriptionMinutePurchase({
              purchaseId: minutePurchase._id,
              checkoutRequestId,
              merchantRequestId,
              resultCode,
              metadata
            });
          } catch (verificationError) {
            console.error(
              "Transcription minute payment verification failed safely:",
              verificationError.message
            );
            verification = {
              verified: false,
              reason: verificationError.code || "VERIFICATION_ERROR"
            };
          }
        }

        if (verification.verified) {
          await DarajaCallbackEvent.updateOne(
            { eventKey },
            { $set: { processingStatus: "processed" } }
          );

          console.info(
            "Transcription minute purchase verified:",
            String(minutePurchase._id)
          );

          return res.status(200).json({
            ResultCode: 0,
            ResultDesc: "Payment verified; transcription minutes credited"
          });
        }

        await Promise.all([
          DarajaCallbackEvent.updateOne(
            { eventKey },
            { $set: { processingStatus: "reconciliation_required" } }
          ),
          MinutePurchase.updateOne(
            {
              _id: minutePurchase._id,
              paymentStatus: { $in: ["pending", "verification_required"] }
            },
            {
              $set: {
                paymentStatus: "verification_required",
                failureCode: String(
                  verification.reason || "CALLBACK_REQUIRES_RECONCILIATION"
                ).slice(0, 100),
                failureDescription: resultCode === 0
                  ? "Automatic payment verification has not completed. The purchase remains unresolved and will be retried."
                  : "Safaricom reported an unsuccessful payment. No minutes were credited; reconcile the payment status before retrying."
              }
            }
          )
        ]);

        console.info(
          "Transcription minute callback deferred:",
          String(minutePurchase._id),
          verification.reason || "UNCONFIRMED"
        );

        return res.status(200).json({
          ResultCode: 0,
          ResultDesc: "Callback stored; payment verification is pending"
        });
      }

      const notesPointsPurchase = await NotesPointsPurchase.findOne({
        checkoutRequestId
      });

      if (notesPointsPurchase) {
        let verification = {
          verified: false,
          reason: resultCode === 0
            ? "CALLBACK_REQUIRES_RECONCILIATION"
            : "PAYMENT_NOT_SUCCESSFUL"
        };

        if (resultCode === 0) {
          try {
            verification = await verifyAndCreditNotesPointsPurchase({
              purchaseId: notesPointsPurchase._id,
              checkoutRequestId,
              merchantRequestId,
              resultCode,
              metadata
            });
          } catch (verificationError) {
            console.error(
              "Notes Points payment verification failed safely:",
              verificationError.message
            );
            verification = {
              verified: false,
              reason: verificationError.code || "VERIFICATION_ERROR"
            };
          }
        }

        if (verification.verified) {
          await DarajaCallbackEvent.updateOne(
            { eventKey },
            { $set: { processingStatus: "processed" } }
          );

          console.info(
            "Notes Points purchase verified:",
            String(notesPointsPurchase._id)
          );

          return res.status(200).json({
            ResultCode: 0,
            ResultDesc: "Payment verified; Notes Points credited"
          });
        }

        await Promise.all([
          DarajaCallbackEvent.updateOne(
            { eventKey },
            { $set: { processingStatus: "reconciliation_required" } }
          ),
          NotesPointsPurchase.updateOne(
            {
              _id: notesPointsPurchase._id,
              paymentStatus: { $in: ["pending", "verification_required"] }
            },
            {
              $set: {
                paymentStatus: "verification_required",
                failureCode: String(
                  verification.reason || "CALLBACK_REQUIRES_RECONCILIATION"
                ).slice(0, 100),
                failureDescription:
                  "Safaricom payment verification is incomplete. No Points were credited; the purchase remains unresolved."
              }
            }
          )
        ]);

        return res.status(200).json({
          ResultCode: 0,
          ResultDesc: "Callback stored; Notes Points payment requires verification"
        });
      }

      await DarajaCallbackEvent.updateOne(
        { eventKey },
        { $set: { processingStatus: "reconciliation_required" } }
      );

      console.warn(
        "Daraja callback stored for an unknown checkout ID."
      );

      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: "Callback stored for reconciliation"
      });
    }

    if (deposit.status === "completed") {
      await DarajaCallbackEvent.updateOne(
        { eventKey },
        { $set: { processingStatus: "processed" } }
      );
    } else {
      try {
        await verifyAndCompleteDepositCallback({
          requestId: deposit.requestId,
          checkoutRequestId,
          merchantRequestId,
          resultCode,
          metadata,
          ipAddress: req.ip
        });

        await DarajaCallbackEvent.updateOne(
          { eventKey },
          { $set: { processingStatus: "processed" } }
        );
      } catch (verificationError) {
        console.error(
          "Automatic deposit verification incomplete:",
          verificationError.message
        );

        await Promise.all([
          DarajaCallbackEvent.updateOne(
            { eventKey },
            { $set: { processingStatus: "reconciliation_required" } }
          ),
          Deposit.updateOne(
            { _id: deposit._id, status: "pending" },
            {
              $set: {
                resultCode,
                resultDescription:
                  "Automatic Safaricom verification incomplete: " +
                  String(verificationError.message).slice(0, 300)
              }
            }
          )
        ]);
      }
    }

    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: "Callback received"
    });
  } catch (error) {
    console.error(
      "Daraja callback persistence failed:",
      error.message
    );

    return res.status(500).json({
      ResultCode: 1,
      ResultDesc: "Callback could not be stored"
    });
  }
});

module.exports = router;
