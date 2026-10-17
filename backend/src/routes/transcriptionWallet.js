const express = require('express');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const requireAuth = require('../middleware/requireAuth');
const Wallet = require('../models/TranscriptionWallet');
const Transaction = require('../models/TranscriptionWalletTransaction');
const Withdrawal = require('../models/TranscriptionWithdrawal');

const router = express.Router();
router.use(requireAuth);

function normalizePhone(value) {
  const digits = String(value || '').replace(/[\s()+-]/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return null;
}

router.get('/', async (req, res) => {
  try {
    const wallet = await Wallet.findOneAndUpdate(
      { userId: req.user._id },
      { $setOnInsert: { userId: req.user._id } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return res.json({
      wallet: {
        currency: 'USD',
        availableBalance: wallet.availableBalanceCents / 100,
        pendingEarnings: wallet.pendingEarningsCents / 100,
        totalEarnings: wallet.totalEarningsCents / 100,
        totalWithdrawals: wallet.totalWithdrawalsCents / 100,
        updatedAt: wallet.updatedAt
      }
    });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to load transcription wallet.' });
  }
});

router.get('/transactions', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const items = await Transaction.find({ userId: req.user._id })
      .sort({ createdAt: -1 }).limit(limit).lean();

    return res.json({
      transactions: items.map(item => ({
        id: item._id,
        type: item.type,
        amount: item.amountCents / 100,
        currency: item.currency,
        status: item.status,
        reference: item.reference,
        description: item.description,
        createdAt: item.createdAt
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to load transcription transactions.' });
  }
});

router.get('/withdrawals', async (req, res) => {
  try {
    const items = await Withdrawal.find({ userId: req.user._id })
      .sort({ createdAt: -1 }).limit(100).lean();

    return res.json({
      withdrawals: items.map(item => ({
        id: item._id,
        requestId: item.requestId,
        amount: item.amountCents / 100,
        currency: item.currency,
        phoneNumber: item.phoneNumber,
        status: item.status,
        reviewNote: item.reviewNote,
        mpesaReceipt: item.mpesaReceipt,
        createdAt: item.createdAt,
        reviewedAt: item.reviewedAt
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to load transcription withdrawals.' });
  }
});

router.post('/withdrawals', async (req, res) => {
  const raw = req.body?.amount;
  const amountText = typeof raw === 'number' ? String(raw) : String(raw || '').trim();

  if (!/^\d+(?:\.\d{1,2})?$/.test(amountText)) {
    return res.status(400).json({
      message: 'Enter a USD amount with no more than two decimal places.'
    });
  }

  const amountCents = Math.round(Number(amountText) * 100);
  if (!Number.isSafeInteger(amountCents) || amountCents < 600) {
    return res.status(400).json({ message: 'Minimum withdrawal is $6.00 USD.' });
  }

  const phoneNumber = normalizePhone(req.body?.phoneNumber);
  if (!phoneNumber) {
    return res.status(400).json({
      message: 'Enter a valid Kenyan M-Pesa number, such as 0712345678.'
    });
  }

  let session;
  try {
    session = await mongoose.startSession();
    let result;

    await session.withTransaction(async () => {
      const wallet = await Wallet.findOneAndUpdate(
        {
          userId: req.user._id,
          availableBalanceCents: { $gte: amountCents }
        },
        { $inc: { availableBalanceCents: -amountCents } },
        { new: true, session }
      );

      if (!wallet) {
        const exists = await Wallet.exists({ userId: req.user._id }).session(session);
        const error = new Error(
          exists ? 'Insufficient transcription wallet balance.' :
            'Transcription wallet has not been initialized.'
        );
        error.statusCode = exists ? 400 : 409;
        throw error;
      }

      const requestId = `TW-${crypto.randomUUID()}`;
      const [withdrawal] = await Withdrawal.create([{
        requestId,
        userId: req.user._id,
        amountCents,
        phoneNumber,
        status: 'pending_review'
      }], { session });

      const [transaction] = await Transaction.create([{
        userId: req.user._id,
        type: 'withdrawal',
        amountCents,
        status: 'pending',
        reference: requestId,
        description: 'Transcription wallet withdrawal request',
        transcriptionWithdrawalId: withdrawal._id
      }], { session });

      withdrawal.walletTransactionId = transaction._id;
      await withdrawal.save({ session });

      result = {
        requestId,
        amount: amountCents / 100,
        currency: 'USD',
        status: withdrawal.status,
        phoneNumber
      };
    });

    return res.status(201).json({
      message: 'Withdrawal request submitted for review.',
      withdrawal: result
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }

    if (/transaction numbers are only allowed|replica set|mongos|does not support transactions/i.test(error.message || '')) {
      return res.status(503).json({
        message: 'MongoDB transaction support is required. No withdrawal was processed.'
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        message: 'A duplicate financial record was prevented. Check the wallet before retrying.'
      });
    }

    return res.status(500).json({ message: 'Unable to submit withdrawal request.' });
  } finally {
    if (session) await session.endSession();
  }
});

module.exports = router;
