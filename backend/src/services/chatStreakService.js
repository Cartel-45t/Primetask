"use strict";

const KENYA_TIME_ZONE = "Africa/Nairobi";
const STREAK_UNLOCK_DAYS = 6;
const REWARD_CENTS_PER_PARTICIPANT = 3;

function getKenyaDayKey(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError("A valid date is required.");
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: KENYA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function getPreviousKenyaDayKey(dayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    throw new TypeError("dayKey must use YYYY-MM-DD format.");
  }

  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new TypeError("dayKey must be a valid calendar date.");
  }

  date.setUTCDate(date.getUTCDate() - 1);

  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function calculateNextStreak({
  currentStreakDays = 0,
  lastQualifiedDayKey = null,
  qualifyingDayKey
}) {
  if (!Number.isSafeInteger(currentStreakDays) || currentStreakDays < 0) {
    throw new TypeError("currentStreakDays must be a non-negative integer.");
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(qualifyingDayKey || "")) {
    throw new TypeError("qualifyingDayKey must use YYYY-MM-DD format.");
  }

  if (lastQualifiedDayKey === qualifyingDayKey) {
    return {
      streakDays: currentStreakDays,
      alreadyQualified: true
    };
  }

  const previousDay = getPreviousKenyaDayKey(qualifyingDayKey);
  const continuesStreak = lastQualifiedDayKey === previousDay;

  return {
    streakDays: continuesStreak ? currentStreakDays + 1 : 1,
    alreadyQualified: false
  };
}

module.exports = {
  KENYA_TIME_ZONE,
  STREAK_UNLOCK_DAYS,
  REWARD_CENTS_PER_PARTICIPANT,
  getKenyaDayKey,
  getPreviousKenyaDayKey,
  calculateNextStreak
};
