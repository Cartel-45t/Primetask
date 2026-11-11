"use strict";

const crypto = require("node:crypto");

const OTP_LIFETIME_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const RESEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_RESENDS_PER_WINDOW = 5;

function generateVerificationCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

function hashVerificationCode({ userId, email, code }) {
  const secret =
    process.env.EMAIL_VERIFICATION_SECRET ||
    process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("Email verification signing secret is not configured.");
  }

  return crypto
    .createHmac("sha256", secret)
    .update(`${String(userId)}:${String(email).toLowerCase()}:${code}`)
    .digest("hex");
}

function verifyCodeHash({ userId, email, code, storedHash }) {
  if (
    typeof code !== "string" ||
    !/^\d{6}$/.test(code) ||
    typeof storedHash !== "string" ||
    !/^[a-f0-9]{64}$/i.test(storedHash)
  ) {
    return false;
  }

  const candidate = Buffer.from(
    hashVerificationCode({ userId, email, code }),
    "hex"
  );

  const stored = Buffer.from(storedHash, "hex");

  return candidate.length === stored.length &&
    crypto.timingSafeEqual(candidate, stored);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendVerificationEmail({ email, firstName, code }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    throw new Error("Resend email configuration is missing.");
  }

  if (!/^\d{6}$/.test(String(code))) {
    throw new Error("Invalid email verification code.");
  }

  const safeName = escapeHtml(firstName || "there");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Verify your PrimeTask Workspace email",
      text:
        `Hello ${firstName || "there"},\n\n` +
        `Your PrimeTask Workspace verification code is: ${code}\n\n` +
        "This code expires in 10 minutes and can only be used once. " +
        "Do not share it with anyone.\n\n" +
        "If you did not create this account, you can ignore this email.",
      html: `
        <div style="margin:0;padding:32px 16px;background:#050b18;font-family:Arial,sans-serif;color:#e5edf9">
          <div style="max-width:560px;margin:0 auto;padding:32px;background:#0b1426;border:1px solid #1d3557;border-radius:16px">
            <p style="color:#60a5fa;font-size:12px;letter-spacing:2px;font-weight:bold">PRIMETASK WORKSPACE</p>
            <h1 style="font-size:25px;color:#f8fafc">Verify your email address</h1>
            <p>Hello ${safeName},</p>
            <p>Enter this verification code on PrimeTask Workspace to complete your registration:</p>
            <div style="margin:28px 0;padding:20px;background:#111f36;border:1px solid #29466d;border-radius:12px;text-align:center">
              <span style="font-size:32px;font-weight:bold;letter-spacing:9px;color:#ffffff">${code}</span>
            </div>
            <p>This code expires in <strong>10 minutes</strong> and can only be used once.</p>
            <p>Never share this code with anyone, including someone claiming to be PrimeTask support.</p>
            <p>If you did not create this account, ignore this email.</p>
            <p style="margin-top:28px;color:#94a3b8;font-size:12px">PrimeTask Workspace · Work. Learn. Grow.</p>
          </div>
        </div>`
    })
  });

  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    let providerMessage = "";

    try {
      const details = JSON.parse(responseText);
      providerMessage =
        typeof details.message === "string"
          ? details.message
          : typeof details.error === "string"
            ? details.error
            : "";
    } catch {
      // Ignore non-JSON provider responses.
    }

    throw new Error(
      `Resend rejected the verification email (HTTP ${response.status})` +
      (providerMessage ? `: ${providerMessage}` : ".")
    );
  }

  return true;
}

module.exports = {
  OTP_LIFETIME_MS,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  RESEND_WINDOW_MS,
  MAX_RESENDS_PER_WINDOW,
  generateVerificationCode,
  hashVerificationCode,
  verifyCodeHash,
  sendVerificationEmail
};
