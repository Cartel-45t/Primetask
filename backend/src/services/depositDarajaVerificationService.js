const Deposit = require("../models/Deposit");
const { queryStkPush } = require("./darajaService");
const { completeVerifiedDeposit } = require("./depositService");

async function verifyAndCompleteDepositCallback({
  requestId,
  checkoutRequestId,
  merchantRequestId,
  resultCode,
  metadata,
  ipAddress
}) {
  if (Number(resultCode) !== 0) {
    throw new Error("Safaricom callback reports an unsuccessful payment.");
  }

  if (
    !checkoutRequestId ||
    !metadata ||
    !/^[A-Z0-9]{6,30}$/.test(String(metadata.receipt || "")) ||
    !Number.isInteger(Number(metadata.amountKes)) ||
    Number(metadata.amountKes) < 1 ||
    !/^254[17]\d{8}$/.test(String(metadata.phoneNumber || ""))
  ) {
    throw new Error("Callback payment details are incomplete or invalid.");
  }

  const deposit = await Deposit.findOne({ requestId });

  if (!deposit) {
    throw new Error("Matching deposit request was not found.");
  }

  if (
    deposit.paymentMode !== "daraja" ||
    deposit.checkoutRequestId !== checkoutRequestId
  ) {
    throw new Error("Deposit checkout ID does not match.");
  }

  if (
    deposit.merchantRequestId &&
    deposit.merchantRequestId !== merchantRequestId
  ) {
    throw new Error("Deposit merchant request ID does not match.");
  }

  if (Number(deposit.expectedAmountKes) !== Number(metadata.amountKes)) {
    throw new Error("Callback amount does not match the expected M-Pesa amount.");
  }

  if (String(deposit.phoneNumber) !== String(metadata.phoneNumber)) {
    throw new Error("Callback phone number does not match the deposit.");
  }

  if (deposit.status === "completed") {
    if (deposit.mpesaReceipt !== metadata.receipt) {
      throw new Error("Deposit was completed with a different receipt.");
    }

    return { status: "completed", alreadyCompleted: true };
  }

  if (deposit.status !== "pending") {
    throw new Error("Deposit is not pending.");
  }

  const verification = await queryStkPush({ checkoutRequestId });

  if (
    verification.mode !== "live" ||
    String(verification.responseCode) !== "0" ||
    String(verification.resultCode) !== "0" ||
    verification.checkoutRequestId !== checkoutRequestId
  ) {
    throw new Error(
      "Safaricom STK query did not independently confirm successful payment."
    );
  }

  return completeVerifiedDeposit({
    requestId,
    resultCode: 0,
    amountKes: Number(metadata.amountKes),
    mpesaReceipt: String(metadata.receipt),
    checkoutRequestId,
    evidenceSource: "daraja_provider_confirmation",
    evidenceReference: checkoutRequestId,
    ipAddress
  });
}

module.exports = { verifyAndCompleteDepositCallback };
