"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  KENYA_TIME_ZONE,
  STREAK_UNLOCK_DAYS,
  REWARD_CENTS_PER_PARTICIPANT,
  getKenyaDayKey,
  getPreviousKenyaDayKey,
  calculateNextStreak
} = require("../src/services/chatStreakService");

test("chat streak uses Kenya calendar days and reward rules", () => {
  assert.equal(KENYA_TIME_ZONE, "Africa/Nairobi");
  assert.equal(STREAK_UNLOCK_DAYS, 6);
  assert.equal(REWARD_CENTS_PER_PARTICIPANT, 3);
  assert.equal(
    getKenyaDayKey(new Date("2026-10-23T21:30:00.000Z")),
    "2026-10-24"
  );
});

test("previous day handles month and year boundaries", () => {
  assert.equal(getPreviousKenyaDayKey("2026-11-01"), "2026-10-31");
  assert.equal(getPreviousKenyaDayKey("2026-01-01"), "2025-12-31");
});

test("a consecutive qualifying day advances the streak", () => {
  assert.deepEqual(
    calculateNextStreak({
      currentStreakDays: 5,
      lastQualifiedDayKey: "2026-10-23",
      qualifyingDayKey: "2026-10-24"
    }),
    { streakDays: 6, alreadyQualified: false }
  );
});

test("a missed day restarts the streak at one", () => {
  assert.deepEqual(
    calculateNextStreak({
      currentStreakDays: 5,
      lastQualifiedDayKey: "2026-10-22",
      qualifyingDayKey: "2026-10-24"
    }),
    { streakDays: 1, alreadyQualified: false }
  );
});

test("the same day cannot increment a streak twice", () => {
  assert.deepEqual(
    calculateNextStreak({
      currentStreakDays: 6,
      lastQualifiedDayKey: "2026-10-24",
      qualifyingDayKey: "2026-10-24"
    }),
    { streakDays: 6, alreadyQualified: true }
  );
});

test("invalid dates and streak values are rejected", () => {
  assert.throws(() => getPreviousKenyaDayKey("2026-02-30"), TypeError);
  assert.throws(() => getPreviousKenyaDayKey("not-a-date"), TypeError);
  assert.throws(
    () => calculateNextStreak({
      currentStreakDays: -1,
      lastQualifiedDayKey: null,
      qualifyingDayKey: "2026-10-24"
    }),
    TypeError
  );
});
