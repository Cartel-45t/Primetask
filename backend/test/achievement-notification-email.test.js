"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  sendCommissionEmail
} = require("../src/services/achievementNotificationEmailService");

test("commission email uses recipient, downline, amount and actual level", async t => {
  const previousApiKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.EMAIL_FROM;
  const previousFetch = global.fetch;

  t.after(() => {
    if (previousApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousApiKey;

    if (previousFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousFrom;

    global.fetch = previousFetch;
  });

  process.env.RESEND_API_KEY = "test-api-key";
  process.env.EMAIL_FROM = "PrimeTask Test <test@example.com>";

  let sentPayload;

  global.fetch = async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    sentPayload = JSON.parse(options.body);

    return {
      ok: true,
      json: async () => ({ id: "test-email-id" })
    };
  };

  const result = await sendCommissionEmail({
    email: "keith@example.com",
    firstName: "Keith",
    amountCents: 500,
    downlineName: "Hivo",
    level: 1
  });

  assert.equal(result.id, "test-email-id");
  assert.equal(
    sentPayload.subject,
    "Commission Received +$5.00 from Hivo 🎉"
  );

  assert.deepEqual(sentPayload.to, ["keith@example.com"]);
  assert.match(sentPayload.text, /Hello Keith/);
  assert.match(sentPayload.text, /\+\$5\.00 commission from Hivo \(Level 1\)/);
  assert.match(sentPayload.text, /Thank you for believing in our dream/);
  assert.match(sentPayload.text, /Have a blissful day ahead/);
  assert.match(sentPayload.html, /Hivo/);
  assert.match(sentPayload.html, /Level 1/);
  assert.match(sentPayload.html, /\+\$5\.00/);
});

test("commission email rejects an invalid level", async () => {
  await assert.rejects(
    sendCommissionEmail({
      email: "keith@example.com",
      firstName: "Keith",
      amountCents: 500,
      downlineName: "Hivo",
      level: 5
    }),
    /Invalid commission notification level/
  );
});
