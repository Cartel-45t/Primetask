const REQUEST_TIMEOUT_MS = 15000;

function getEnvironment() {
  const value = String(process.env.DARAJA_ENV || "sandbox")
    .trim()
    .toLowerCase();

  if (!["sandbox", "production"].includes(value)) {
    throw new Error("DARAJA_ENV must be sandbox or production.");
  }

  return value;
}

function getBaseUrl() {
  return getEnvironment() === "sandbox"
    ? "https://sandbox.safaricom.co.ke"
    : "https://api.safaricom.co.ke";
}

function requireHttpsUrl(value, name, callbackToken) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid public HTTPS URL.`);
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1"
  ) {
    throw new Error(`${name} must be a public HTTPS URL.`);
  }

  if (
    !callbackToken ||
    callbackToken.length < 32 ||
    parsed.searchParams.get("token") !== callbackToken
  ) {
    throw new Error(
      `${name} must include the configured B2C callback token.`
    );
  }

  return parsed.toString();
}

function getB2CConfig() {
  const consumerKey = process.env.DARAJA_CONSUMER_KEY;
  const consumerSecret = process.env.DARAJA_CONSUMER_SECRET;
  const shortcode = String(
    process.env.DARAJA_B2C_SHORTCODE || ""
  ).trim();
  const initiatorName = String(
    process.env.DARAJA_B2C_INITIATOR_NAME || ""
  ).trim();
  const securityCredential = String(
    process.env.DARAJA_B2C_SECURITY_CREDENTIAL || ""
  ).trim();
  const commandId = String(
    process.env.DARAJA_B2C_COMMAND_ID || "BusinessPayment"
  ).trim();

  if (!consumerKey || !consumerSecret) {
    throw new Error("Daraja OAuth credentials are not configured.");
  }

  if (!/^\d{5,7}$/.test(shortcode)) {
    throw new Error("DARAJA_B2C_SHORTCODE is invalid.");
  }

  if (!/^[A-Za-z0-9._-]{1,50}$/.test(initiatorName)) {
    throw new Error("DARAJA_B2C_INITIATOR_NAME is invalid.");
  }

  if (securityCredential.length < 20) {
    throw new Error(
      "DARAJA_B2C_SECURITY_CREDENTIAL is missing or invalid."
    );
  }

  if (
    !["BusinessPayment", "SalaryPayment", "PromotionPayment"]
      .includes(commandId)
  ) {
    throw new Error("DARAJA_B2C_COMMAND_ID is invalid.");
  }

  const callbackToken = String(
    process.env.DARAJA_B2C_CALLBACK_TOKEN || ""
  );

  if (callbackToken.length < 32) {
    throw new Error(
      "DARAJA_B2C_CALLBACK_TOKEN must contain at least 32 characters."
    );
  }

  return {
    consumerKey,
    consumerSecret,
    shortcode,
    initiatorName,
    securityCredential,
    commandId,
    resultUrl: requireHttpsUrl(
      process.env.DARAJA_B2C_RESULT_URL,
      "DARAJA_B2C_RESULT_URL",
      callbackToken
    ),
    timeoutUrl: requireHttpsUrl(
      process.env.DARAJA_B2C_TIMEOUT_URL,
      "DARAJA_B2C_TIMEOUT_URL",
      callbackToken
    )
  };
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
      const error = new Error(
        "Daraja returned an unreadable response."
      );
      error.code = "DARAJA_RESPONSE_UNKNOWN";
      throw error;
    }

    if (!response.ok) {
      const error = new Error(
        `Daraja returned HTTP ${response.status}.`
      );
      error.code = "DARAJA_RESPONSE_UNKNOWN";
      error.statusCode = response.status;
      throw error;
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(
        "Daraja request timed out; payout outcome is unknown."
      );
      timeoutError.code = "DARAJA_B2C_OUTCOME_UNKNOWN";
      throw timeoutError;
    }

    if (!error.code) {
      error.code = "DARAJA_B2C_OUTCOME_UNKNOWN";
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getAccessToken(config) {
  const credentials = Buffer.from(
    `${config.consumerKey}:${config.consumerSecret}`,
    "utf8"
  ).toString("base64");

  const response = await requestJson(
    `${getBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`,
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
 * B2C is disabled unless BOTH gates are explicitly enabled.
 * The caller must persist the unique originator ID and mark the
 * attempt as submitting before calling this function.
 *
 * Never automatically retry an ambiguous initiation response.
 */
async function initiateB2CPayment({
  originatorConversationId,
  phoneNumber,
  amountKes,
  remarks,
  occasion = ""
}) {
  if (
    process.env.DARAJA_LIVE_ENABLED !== "true" ||
    process.env.DARAJA_B2C_ENABLED !== "true"
  ) {
    return {
      mode: "disabled",
      accepted: false,
      message: "Daraja B2C initiation is disabled."
    };
  }

  if (
    typeof originatorConversationId !== "string" ||
    !/^[A-Za-z0-9_-]{8,100}$/.test(originatorConversationId)
  ) {
    throw new Error("A unique B2C originator conversation ID is required.");
  }

  if (!Number.isSafeInteger(amountKes) || amountKes < 1) {
    throw new Error("B2C amount must be a positive whole KSh amount.");
  }

  if (
    typeof phoneNumber !== "string" ||
    !/^254[17]\d{8}$/.test(phoneNumber)
  ) {
    throw new Error("B2C recipient must be a normalized Kenyan phone number.");
  }

  const config = getB2CConfig();

  if (
    typeof remarks !== "string" ||
    !remarks.trim() ||
    remarks.length > 100
  ) {
    throw new Error("B2C remarks must contain 1 to 100 characters.");
  }

  if (
    typeof occasion !== "string" ||
    occasion.length > 100
  ) {
    throw new Error("B2C occasion must not exceed 100 characters.");
  }

  // Obtain OAuth token before the disbursement request is sent.
  const accessToken = await getAccessToken(config);

  const payload = {
    OriginatorConversationID: originatorConversationId,
    InitiatorName: config.initiatorName,
    SecurityCredential: config.securityCredential,
    CommandID: config.commandId,
    Amount: amountKes,
    PartyA: config.shortcode,
    PartyB: phoneNumber,
    Remarks: remarks.trim(),
    QueueTimeOutURL: config.timeoutUrl,
    ResultURL: config.resultUrl,
    Occassion: occasion
  };

  // Do not retry this POST automatically. A timeout may happen after
  // Safaricom has accepted the disbursement request.
  const response = await requestJson(
    `${getBaseUrl()}/mpesa/b2c/v3/paymentrequest`,
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

  const responseCode =
    response.ResponseCode === undefined
      ? null
      : String(response.ResponseCode);

  if (responseCode !== "0") {
    return {
      mode: "live",
      accepted: false,
      definitiveRejection: responseCode !== null,
      originatorConversationId,
      conversationId: response.ConversationID || null,
      responseCode,
      responseDescription:
        typeof response.ResponseDescription === "string"
          ? response.ResponseDescription.slice(0, 500)
          : "Daraja did not confirm acceptance."
    };
  }

  return {
    mode: "live",
    accepted: true,
    definitiveRejection: false,
    originatorConversationId,
    conversationId: response.ConversationID || null,
    responseCode,
    responseDescription:
      typeof response.ResponseDescription === "string"
        ? response.ResponseDescription.slice(0, 500)
        : null
  };
}

module.exports = {
  getB2CConfig,
  initiateB2CPayment
};
