const crypto = require("crypto");

const DARAJA_ENV = String(process.env.DARAJA_ENV || "sandbox")
  .trim()
  .toLowerCase();

const LIVE_ENABLED =
  process.env.DARAJA_LIVE_ENABLED === "true";

const TRANSACTION_TYPE = String(
  process.env.DARAJA_TRANSACTION_TYPE ||
  (DARAJA_ENV === "sandbox" ? "CustomerPayBillOnline" : "")
).trim();

const REQUEST_TIMEOUT_MS = 15000;

function getConfig() {
  const consumerKey = process.env.DARAJA_CONSUMER_KEY;
  const consumerSecret = process.env.DARAJA_CONSUMER_SECRET;
  const storeNumber = String(
    process.env.DARAJA_STORE_NUMBER ||
    process.env.DARAJA_SHORTCODE ||
    ""
  ).trim();
  const tillNumber = String(
    process.env.DARAJA_TILL_NUMBER || ""
  ).trim();
  const passkey = process.env.DARAJA_PASSKEY;
  const callbackUrl = process.env.DARAJA_CALLBACK_URL;

  if (!["CustomerPayBillOnline", "CustomerBuyGoodsOnline"].includes(TRANSACTION_TYPE)) {
    throw new Error(
      "Set DARAJA_TRANSACTION_TYPE to CustomerPayBillOnline or CustomerBuyGoodsOnline."
    );
  }

  if (
    !consumerKey ||
    !consumerSecret ||
    !storeNumber ||
    !passkey
  ) {
    throw new Error("Daraja credentials are not fully configured.");
  }

  if (
    TRANSACTION_TYPE === "CustomerBuyGoodsOnline" &&
    !tillNumber
  ) {
    throw new Error(
      "DARAJA_TILL_NUMBER is required for CustomerBuyGoodsOnline."
    );
  }

  if (!callbackUrl) {
    throw new Error("Daraja callback URL is not configured.");
  }

  let parsedCallback;

  try {
    parsedCallback = new URL(callbackUrl);
  } catch {
    throw new Error("Daraja callback URL is invalid.");
  }

  if (
    parsedCallback.protocol !== "https:" ||
    parsedCallback.hostname === "localhost" ||
    parsedCallback.hostname === "127.0.0.1"
  ) {
    throw new Error(
      "Daraja callback URL must be a publicly reachable HTTPS URL."
    );
  }

  return {
    consumerKey,
    consumerSecret,
    storeNumber,
    tillNumber,
    passkey,
    callbackUrl,
    transactionType: TRANSACTION_TYPE
  };
}

function getBaseUrl() {
  if (DARAJA_ENV === "sandbox") {
    return "https://sandbox.safaricom.co.ke";
  }

  if (DARAJA_ENV === "production") {
    return "https://api.safaricom.co.ke";
  }

  throw new Error("DARAJA_ENV must be sandbox or production.");
}

function getTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, "0");

  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function makeStkPassword(shortcode, passkey, timestamp) {
  return Buffer.from(
    `${shortcode}${passkey}${timestamp}`,
    "utf8"
  ).toString("base64");
}

async function requestJson(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const body = await response.text();

    let data;

    try {
      data = body ? JSON.parse(body) : {};
    } catch {
      throw new Error("Daraja returned an invalid JSON response.");
    }

    if (!response.ok) {
      const error = new Error(
        `Daraja request failed with HTTP ${response.status}.`
      );

      error.statusCode = response.status;
      error.providerResponse = data;

      throw error;
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(
        "Daraja request timed out; payment initiation status is unknown."
      );

      timeoutError.code = "DARAJA_TIMEOUT";
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getAccessToken() {
  const config = getConfig();
  const baseUrl = getBaseUrl();

  const credentials = Buffer.from(
    `${config.consumerKey}:${config.consumerSecret}`,
    "utf8"
  ).toString("base64");

  const response = await requestJson(
    `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
    {
      method: "GET",
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: "application/json"
      }
    }
  );

  if (
    typeof response.access_token !== "string" ||
    !response.access_token
  ) {
    throw new Error("Daraja did not return an access token.");
  }

  return response.access_token;
}

/*
 * This function never contacts Safaricom unless all of these are true:
 * 1. DARAJA_LIVE_ENABLED=true
 * 2. DARAJA_ENV=sandbox or production
 * 3. Credentials and a public HTTPS callback URL are configured.
 *
 * Do not enable live initiation until callback verification is implemented.
 */
async function initiateStkPush({
  phoneNumber,
  amountKes,
  accountReference,
  transactionDesc
}) {
  if (LIVE_ENABLED !== true) {
    return {
      mode: "disabled",
      accepted: false,
      message: "Daraja initiation is disabled."
    };
  }

  if (!Number.isSafeInteger(amountKes) || amountKes < 1) {
    throw new Error("STK amount must be a positive whole KSh amount.");
  }

  if (!/^254[17]\d{8}$/.test(phoneNumber)) {
    throw new Error("Invalid Kenyan phone number.");
  }

  const config = getConfig();
  const timestamp = getTimestamp();
  const password = makeStkPassword(
    config.storeNumber,
    config.passkey,
    timestamp
  );

  const accessToken = await getAccessToken();

  const payload = {
    BusinessShortCode: config.storeNumber,
    Password: password,
    Timestamp: timestamp,
    TransactionType: config.transactionType,
    Amount: amountKes,
    PartyA: phoneNumber,
    PartyB: config.transactionType === "CustomerBuyGoodsOnline"
      ? config.tillNumber
      : config.storeNumber,
    PhoneNumber: phoneNumber,
    CallBackURL: config.callbackUrl,
    AccountReference: String(accountReference).slice(0, 12),
    TransactionDesc: String(transactionDesc).slice(0, 13)
  };

  const response = await requestJson(
    `${getBaseUrl()}/mpesa/stkpush/v1/processrequest`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  return {
    mode: "live",
    accepted: response.ResponseCode === "0",
    merchantRequestId: response.MerchantRequestID || null,
    checkoutRequestId: response.CheckoutRequestID || null,
    responseCode: response.ResponseCode || null,
    responseDescription: response.ResponseDescription || null,
    customerMessage: response.CustomerMessage || null
  };
}


/*
 * Queries the status of a previously initiated STK Push.
 * This does not, by itself, prove the amount or receipt of a payment.
 * Keep live initiation disabled until callback reconciliation is implemented.
 */
async function queryStkPush({ checkoutRequestId }) {
  if (LIVE_ENABLED !== true) {
    return {
      mode: "disabled",
      verified: false,
      message: "Daraja queries are disabled."
    };
  }

  if (
    typeof checkoutRequestId !== "string" ||
    !/^ws_CO_[A-Za-z0-9]+$/.test(checkoutRequestId)
  ) {
    throw new Error("A valid checkout request ID is required.");
  }

  const config = getConfig();
  const timestamp = getTimestamp();
  const password = makeStkPassword(
    config.storeNumber,
    config.passkey,
    timestamp
  );

  const accessToken = await getAccessToken();

  const response = await requestJson(
    `${getBaseUrl()}/mpesa/stkpushquery/v1/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        BusinessShortCode: config.storeNumber,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId
      })
    }
  );

  return {
    mode: "live",
    responseCode: response.ResponseCode || null,
    resultCode: response.ResultCode ?? null,
    resultDescription: response.ResultDesc || null,
    checkoutRequestId
  };
}

module.exports = {
  initiateStkPush,
  queryStkPush
};
