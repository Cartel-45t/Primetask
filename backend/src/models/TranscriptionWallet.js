const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  currency: { type: String, enum: ['USD'], default: 'USD', immutable: true },
  availableBalanceCents: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  pendingEarningsCents: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  totalEarningsCents: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  totalWithdrawalsCents: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger }
}, { timestamps: true, versionKey: false });

module.exports = mongoose.models.TranscriptionWallet ||
  mongoose.model('TranscriptionWallet', schema);
