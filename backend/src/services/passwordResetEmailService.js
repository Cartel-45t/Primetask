"use strict";

async function sendPasswordResetEmail({ email, firstName, token }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const publicSiteUrl = process.env.PUBLIC_SITE_URL;

  if (!apiKey || !from || !publicSiteUrl) {
    throw new Error("Resend or public-site email configuration is missing.");
  }

  let baseUrl;

  try {
    baseUrl = new URL(publicSiteUrl);
  } catch {
    throw new Error("PUBLIC_SITE_URL is invalid.");
  }

  if (
    process.env.NODE_ENV === "production" &&
    baseUrl.protocol !== "https:"
  ) {
    throw new Error("PUBLIC_SITE_URL must use HTTPS in production.");
  }

  if (!["http:", "https:"].includes(baseUrl.protocol)) {
    throw new Error("PUBLIC_SITE_URL must be an HTTP(S) URL.");
  }

  const resetUrl = new URL("/auth/reset-password.html", baseUrl);
  resetUrl.searchParams.set("token", token);

  const safeName = String(firstName || "there")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

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
      subject: "Reset your PrimeTask Workspace password",
      text:
        `Hello ${firstName || "there"},\n\n` +
        "We received a request to reset your PrimeTask Workspace password. " +
        "Use the link below within 15 minutes. If you did not request this, " +
        "you can ignore this email.\n\n" +
        `${resetUrl.toString()}\n\n` +
        "For your security, this link can only be used once.",
      html: `
        <div style="margin:0;padding:32px 16px;background:#050b18;font-family:Arial,sans-serif;color:#e5edf9">
          <div style="max-width:560px;margin:0 auto;padding:32px;background:#0b1426;border:1px solid #1d3557;border-radius:16px">
            <p style="color:#60a5fa;font-size:12px;letter-spacing:2px;font-weight:bold">PRIMETASK WORKSPACE</p>
            <h1 style="font-size:25px;color:#f8fafc">Reset your password</h1>
            <p>Hello ${safeName},</p>
            <p>We received a request to reset your PrimeTask Workspace password.</p>
            <p style="margin:28px 0">
              <a href="${resetUrl.toString()}" style="display:inline-block;padding:14px 22px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold">Reset password</a>
            </p>
            <p>This link expires in <strong>15 minutes</strong> and can only be used once.</p>
            <p>If you did not request this, ignore this email. Your current password will remain unchanged.</p>
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
      // The provider did not return JSON.
    }

    if (!providerMessage && responseText) {
      providerMessage = responseText.slice(0, 300);
    }

    throw new Error(
      `Resend rejected the email request (HTTP ${response.status})` +
      (providerMessage ? `: ${providerMessage}` : ".")
    );
  }

  return true;
}

module.exports = { sendPasswordResetEmail };
