const express = require("express");
const { createHash } = require("crypto");
const Deposit = require("../models/Deposit");
const MembershipPurchase = require("../models/MembershipPurchase");
const MinutePurchase = require("../models/TranscriptionMinutePurchase");
const DarajaCallbackEvent = require("../models/DarajaCallbackEvent");

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
      // Membership callbacks are evidence only. They cannot verify payment
      // or activate membership without independent reconciliation.
      const membershipPurchase = await MembershipPurchase.findOne({
        checkoutRequestId
      });

      if (membershipPurchase) {
        await DarajaCallbackEvent.updateOne(
          { eventKey },
          {
            $set: {
              processingStatus: "reconciliation_required"
            }
          }
        );

        // Only pending purchases may transition to reconciliation.
        // Never overwrite verified, failed, or cancelled purchases.
        await MembershipPurchase.updateOne(
          {
            _id: membershipPurchase._id,
            paymentStatus: "pending"
          },
          {
            $set: {
              paymentStatus: "verification_required",
              failureCode: "CALLBACK_REQUIRES_RECONCILIATION",
              failureDescription:
                "A Daraja callback was received. Callback data is untrusted; independently reconcile the payment before activating membership."
            }
          }
        );

        console.info(
          "Membership callback stored for reconciliation:",
          String(membershipPurchase._id)
        );

        return res.status(200).json({
          ResultCode: 0,
          ResultDesc: "Callback stored for payment reconciliation"
        });
      }

      // Transcription callbacks are evidence only. Never credit minutes here.
      const minutePurchase = await MinutePurchase.findOne({
        checkoutRequestId
      });

      await DarajaCallbackEvent.updateOne(
        { eventKey },
        {
          $set: {
            processingStatus: "reconciliation_required"
          }
        }
      );

      if (minutePurchase) {
        // Do not overwrite verified, failed, or cancelled purchases.
        await MinutePurchase.updateOne(
          {
            _id: minutePurchase._id,
            paymentStatus: "pending"
          },
          {
            $set: {
              paymentStatus: "verification_required",
              failureCode: "CALLBACK_REQUIRES_RECONCILIATION",
              failureDescription:
                "A Daraja callback was received. Callback data is untrusted; independently reconcile the payment before crediting minutes."
            }
          }
        );

        console.info(
          "Transcription minute callback stored for reconciliation:",
          String(minutePurchase._id)
        );

        return res.status(200).json({
          ResultCode: 0,
          ResultDesc: "Callback stored for payment reconciliation"
        });
      }

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
      await Promise.all([
        DarajaCallbackEvent.updateOne(
          { eventKey },
          {
            $set: {
              processingStatus: "reconciliation_required"
            }
          }
        ),

        Deposit.updateOne(
          {
            _id: deposit._id,
            status: "pending"
          },
          {
            $set: {
              resultCode,
              resultDescription:
                "Callback stored as untrusted evidence. Independent reconciliation is required before wallet credit."
            }
          }
        )
      ]);
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
