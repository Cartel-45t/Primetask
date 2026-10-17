const express = require("express");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

router.use(requireAuth);

function centsToUSD(cents) {
  return Number((cents / 100).toFixed(2));
}

/*
 * GET /api/wallet
 * Creates an empty wallet if this user does not have one yet.
 * It never creates or credits money.
 */
router.get("/", async (req, res) => {
  try {
    const wallet = await Wallet.findOneAndUpdate(
      { userId: req.user._id },
      {
        $setOnInsert: {
          userId: req.user._id,
          currency: "USD",
          availableBalanceCents: 0,
          pendingEarningsCents: 0,
          totalEarningsCents: 0,
          totalWithdrawalsCents: 0
        }
      },
      {
        returnDocument: 'after',
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true
      }
    ).lean();

    return res.json({
      success: true,
      wallet: {
        currency: "USD",
        availableBalance: centsToUSD(wallet.availableBalanceCents),
        pendingEarnings: centsToUSD(wallet.pendingEarningsCents),
        totalEarnings: centsToUSD(wallet.totalEarningsCents),
        totalWithdrawals: centsToUSD(wallet.totalWithdrawalsCents),
        updatedAt: wallet.updatedAt
      }
    });
  } catch (error) {
    console.error("Wallet retrieval error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not load your wallet."
    });
  }
});

/*
 * GET /api/wallet/transactions?limit=20&page=1
 * Users can only see transactions belonging to their own account.
 */
router.get("/transactions", async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const requestedLimit = Number.parseInt(req.query.limit, 10) || 20;
    const limit = Math.min(50, Math.max(1, requestedLimit));
    const skip = (page - 1) * limit;

    const filter = { userId: req.user._id };

    const [transactions, total] = await Promise.all([
      WalletTransaction.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .select(
          "type amountCents currency status reference description createdAt completedAt"
        )
        .lean(),

      WalletTransaction.countDocuments(filter)
    ]);

    return res.json({
      success: true,
      currency: "USD",
      page,
      limit,
      total,
      transactions: transactions.map((item) => ({
        id: item._id,
        type: item.type,
        amount: centsToUSD(item.amountCents),
        currency: item.currency,
        status: item.status,
        reference: item.reference,
        description: item.description,
        createdAt: item.createdAt,
        completedAt: item.completedAt
      }))
    });
  } catch (error) {
    console.error("Wallet transaction history error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not load transaction history."
    });
  }
});

module.exports = router;
