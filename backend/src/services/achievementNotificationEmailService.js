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

async function sendCommissionEmail({ email, firstName, amountCents }) {
  const name = firstName || "Member";
  const amount = formatUsd(amountCents);

  const text = `Hello ${name},
Congratulations on achieving another milestone with PrimeTask Workspace! 🎉
Your efforts and contribution to our growing community have earned you a referral commission of $${amount}.
This achievement reflects the opportunities you've helped create and the value you've brought to the PrimeTask community.

Regards
 admin🎉`;

  const safeName = escapeHtml(name);
  const safeAmount = escapeHtml(amount);

  const html = `
    <div style="font-family:Arial,sans-serif;color:#172033;line-height:1.7">
      <p>Hello ${safeName},</p>
      <p>Congratulations on achieving another milestone with PrimeTask Workspace! 🎉</p>
      <p>Your efforts and contribution to our growing community have earned you a referral commission of <strong>$${safeAmount}</strong>.</p>
      <p>This achievement reflects the opportunities you've helped create and the value you've brought to the PrimeTask community.</p>
      <p>Regards<br>admin🎉</p>
    </div>
  `;

  return sendEmail({
    email,
    subject: "Congratulations on Your Achievement",
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
