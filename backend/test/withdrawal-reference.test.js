"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Withdrawal = require("../src/models/Withdrawal");

function makeWithdrawal(overrides = {}) {
  return new Withdrawal({
    requestId: "WD-TEST-REFERENCE-001",
    userId: new mongoose.Types.ObjectId(),
    amountCents: 1000,
    currency: "USD",
    phoneNumber: "0712345678",
    ...overrides
  });
}

test("accepts a correctly formatted public withdrawal reference", async () => {
  const withdrawal = makeWithdrawal({
    publicReference: "PTW-WC7K2M9X4Q"
  });

  await assert.doesNotReject(() => withdrawal.validate());
});

test("rejects a public reference with the wrong prefix", async () => {
  const withdrawal = makeWithdrawal({
    publicReference: "ABC-WC7K2M9X4Q"
  });

  await assert.rejects(
    withdrawal.validate(),
    error => Boolean(error.errors?.publicReference)
  );
});

test("rejects a public reference with too few characters", async () => {
  const withdrawal = makeWithdrawal({
    publicReference: "PTW-WC7K2M9X"
  });

  await assert.rejects(
    withdrawal.validate(),
    error => Boolean(error.errors?.publicReference)
  );
});

test("rejects lowercase characters in a public reference", async () => {
  const withdrawal = makeWithdrawal({
    publicReference: "PTW-WC7k2M9X4Q"
  });

  await assert.rejects(
    withdrawal.validate(),
    error => Boolean(error.errors?.publicReference)
  );
});

test("allows legacy withdrawals without a public reference", async () => {
  const withdrawal = makeWithdrawal();

  await assert.doesNotReject(() => withdrawal.validate());
});
