"use strict";

const RESEND_API_URL = "https://api.resend.com/emails";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function formatUsd(amountCents) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new Error("Invalid USD notification amount.");
  }

  return (amountCents / 100).toFixed(2);
}

async function sendEmail({ email, subject, text, html }) {
  if (!email) {
    throw new Error("Notification recipient email is missing.");
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    throw new Error("RESEND_API_KEY or EMAIL_FROM is not configured.");
  }

  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject,
      text,
      html
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `Resend email failed (${response.status}): ${details.slice(0, 500)}`
    );
  }

  return response.json();
}

async function sendCommissionEmail({
  email,
  firstName,
  amountCents,
  downlineName,
  level
}) {
  const recipientName = firstName || "Member";
  const memberName = String(downlineName || "your downline member").trim();
  const amount = formatUsd(amountCents);

  if (!Number.isSafeInteger(level) || level < 1 || level > 4) {
    throw new Error("Invalid commission notification level.");
  }

  const safeRecipient = escapeHtml(recipientName);
  const safeDownline = escapeHtml(memberName);
  const safeAmount = escapeHtml(amount);
  const levelLabel = `Level ${level}`;

  const subject = `Commission Received +$${amount} from ${memberName} 🎉`;

  const text = `Hello ${recipientName},

Good news! 🎉

You've received a +$${amount} commission from ${memberName} (${levelLabel}) through PrimeTask Workspace.

Thank you for believing in our dream and growing with us. Every step forward is made possible by people like you.

We appreciate your trust and support.

Have a blissful day ahead!

Warm regards,
PrimeTask Workspace Team
Creating Opportunities and delivering excellence.`;

  const html = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta name="color-scheme" content="light">
        <title>${escapeHtml(subject)}</title>
      </head>
      <body style="margin:0;padding:0;background:#eef2f8;font-family:Arial,Helvetica,sans-serif;color:#172033;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#eef2f8;padding:32px 12px;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">
                <tr>
                  <td style="background:#101d38;padding:28px 32px;text-align:center;">
                    <div style="font-size:25px;font-weight:800;letter-spacing:0.3px;color:#ffffff;">PrimeTask <span style="color:#f59e0b;">Workspace</span></div>
                    <div style="margin-top:8px;font-size:12px;letter-spacing:1.2px;color:#c8d5eb;">COMMISSION NOTIFICATION</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:34px 32px 18px;">
                    <p style="margin:0 0 18px;font-size:16px;line-height:1.6;">Hello ${safeRecipient},</p>
                    <p style="margin:0 0 18px;font-size:16px;line-height:1.6;">Good news! 🎉</p>
                    <div style="margin:22px 0;padding:24px 16px;text-align:center;background:#f3f7ff;border:1px solid #dce7fa;border-radius:12px;">
                      <div style="font-size:13px;font-weight:700;letter-spacing:1px;color:#52627d;text-transform:uppercase;">Commission received</div>
                      <div style="margin-top:8px;font-size:34px;font-weight:800;color:#13734f;">+$${safeAmount}</div>
                      <div style="margin-top:12px;font-size:15px;color:#263653;">From <strong>${safeDownline}</strong></div>
                      <div style="display:inline-block;margin-top:10px;padding:6px 13px;border-radius:20px;background:#fff0d8;color:#945500;font-size:12px;font-weight:700;">${levelLabel}</div>
                    </div>
                    <p style="margin:22px 0;font-size:16px;line-height:1.75;color:#263247;">
                      You've received a <strong>+$${safeAmount} commission from ${safeDownline} (${levelLabel})</strong> through PrimeTask Workspace.
                    </p>
                    <p style="margin:0 0 16px;font-size:15px;line-height:1.8;color:#43516a;">
                      Thank you for believing in our dream and growing with us. Every step forward is made possible by people like you.
                    </p>
                    <p style="margin:0 0 22px;font-size:15px;line-height:1.8;color:#43516a;">
                      We appreciate your trust and support.
                    </p>
                    <p style="margin:0 0 28px;font-size:16px;font-weight:700;color:#172033;">Have a blissful day ahead!</p>
                    <p style="margin:0;font-size:14px;line-height:1.7;color:#43516a;">
                      Warm regards,<br>
                      <strong style="color:#172033;">PrimeTask Workspace Team</strong><br>
                      <span style="color:#64748b;">Creating Opportunities and delivering excellence.</span>
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:18px 32px;background:#f7f9fc;text-align:center;border-top:1px solid #e8edf5;">
                    <p style="margin:0;font-size:11px;line-height:1.6;color:#8290a5;">This is an automated notification from PrimeTask Workspace.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;

  return sendEmail({
    email,
    subject,
    text,
    html
  });
}

async function sendTranscriptionApprovalEmail({
  email,
  firstName,
  amountCents
}) {
  const name = firstName || "Member";
  const amount = formatUsd(amountCents);

  const text = `Hello ${name},

Congratulations! Your transcription submission has been approved, and $${amount} USD has been credited to your transcription wallet.

Thank you for your contribution to PrimeTask Workspace.

Regards,
Admin 🎉`;

  const html = `
    <div style="font-family:Arial,sans-serif;color:#172033;line-height:1.7">
      <p>Hello ${escapeHtml(name)},</p>
      <p>Congratulations! Your transcription submission has been approved, and <strong>$${escapeHtml(amount)} USD</strong> has been credited to your transcription wallet.</p>
      <p>Thank you for your contribution to PrimeTask Workspace.</p>
      <p>Regards,<br>Admin 🎉</p>
    </div>
  `;

  return sendEmail({
    email,
    subject: "Your Transcription Was Approved",
    text,
    html
  });
}

async function sendNotesApprovalEmail({
  email,
  firstName,
  amountCents
}) {
  const name = firstName || "Member";
  const amount = formatUsd(amountCents);

  const text = `Hello ${name},

Congratulations! Your PrimeTask Notes submission has been approved, and $${amount} USD has been credited to your Notes earnings wallet.

Thank you for your contribution to PrimeTask Workspace.

Regards,
Admin 🎉`;

  const html = `
    <div style="font-family:Arial,sans-serif;color:#172033;line-height:1.7">
      <p>Hello ${escapeHtml(name)},</p>
      <p>Congratulations! Your PrimeTask Notes submission has been approved, and <strong>$${escapeHtml(amount)} USD</strong> has been credited to your Notes earnings wallet.</p>
      <p>Thank you for your contribution to PrimeTask Workspace.</p>
      <p>Regards,<br>Admin 🎉</p>
    </div>
  `;

  return sendEmail({
    email,
    subject: "Your Notes Were Approved",
    text,
    html
  });
}

module.exports = {
  sendCommissionEmail,
  sendTranscriptionApprovalEmail,
  sendNotesApprovalEmail
};
