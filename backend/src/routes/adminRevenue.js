"use strict";

const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const MembershipPurchase = require("../models/MembershipPurchase");
const Commission = require("../models/Commission");

const router = express.Router();

router.use(requireAuth);
router.use((req, res, next) => {
  if (!["admin", "founder"].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: "Administrator access is required." });
  }
  next();
});

function parseDate(value, endOfDay = false) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + (endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"));
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

function dollars(cents) {
  return Number((Number(cents || 0) / 100).toFixed(2));
}

router.get("/", async (req, res) => {
  try {
    const now = new Date();
    const defaultTo = now.toISOString().slice(0, 10);
    const defaultFromDate = new Date(now);
    defaultFromDate.setUTCDate(defaultFromDate.getUTCDate() - 29);
    const defaultFrom = defaultFromDate.toISOString().slice(0, 10);

    const fromText = req.query.from || defaultFrom;
    const toText = req.query.to || defaultTo;
    const from = parseDate(fromText);
    const to = parseDate(toText, true);

    if (!from || !to || from > to) {
      return res.status(400).json({
        success: false,
        message: "Use valid from/to dates in YYYY-MM-DD format, with from no later than to."
      });
    }

    if ((to.getTime() - from.getTime()) / 86400000 > 366) {
      return res.status(400).json({
        success: false,
        message: "Choose a date range of 367 days or fewer."
      });
    }

    const [salesRows, commissionRows] = await Promise.all([
      MembershipPurchase.aggregate([
        { $match: { paymentStatus: "verified", verifiedAt: { $gte: from, $lte: to } } },
        { $group: { _id: null, totalCents: { $sum: "$priceCents" }, purchases: { $sum: 1 } } }
      ]),
      Commission.aggregate([
        { $match: { createdAt: { $gte: from, $lte: to } } },
        { $group: { _id: "$status", totalCents: { $sum: "$amountCents" }, count: { $sum: 1 } } }
      ])
    ]);

    const sales = salesRows[0] || { totalCents: 0, purchases: 0 };
    const commissionTotals = {
      pending: { cents: 0, count: 0 },
      paid: { cents: 0, count: 0 },
      reversed: { cents: 0, count: 0 }
    };

    for (const row of commissionRows) {
      if (Object.prototype.hasOwnProperty.call(commissionTotals, row._id)) {
        commissionTotals[row._id] = {
          cents: Number(row.totalCents || 0),
          count: Number(row.count || 0)
        };
      }
    }

    return res.json({
      success: true,
      data: {
        currency: "USD",
        from: fromText,
        to: toText,
        verifiedMembershipSales: dollars(sales.totalCents),
        verifiedPurchaseCount: Number(sales.purchases || 0),
        commissions: {
          pending: { amount: dollars(commissionTotals.pending.cents), count: commissionTotals.pending.count },
          paid: { amount: dollars(commissionTotals.paid.cents), count: commissionTotals.paid.count },
          reversed: { amount: dollars(commissionTotals.reversed.cents), count: commissionTotals.reversed.count }
        },
        salesLessPaidCommissions: dollars(Number(sales.totalCents || 0) - commissionTotals.paid.cents),
        accountingNote: "Verified membership sales are gross sales, not profit. Paid commissions are shown separately. Pending commissions are obligations. Wallet deposits are excluded from revenue."
      }
    });
  } catch (error) {
    console.error("Admin revenue report failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not generate the platform revenue report." });
  }
});

module.exports = router;
