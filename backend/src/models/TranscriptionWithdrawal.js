const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  requestId: { type: String, required: true, unique: true },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  amountCents: {
    type: Number,
    required: true,
    min: 600,
    validate: Number.isSafeInteger
  },
  currency: { type: String, enum: ['USD'], default: 'USD', immutable: true },
  phoneNumber: {
    type: String,
    required: true,
    match: /^254[17]\d{8}$/
  },
  status: {
    type: String,
    enum: ['pending_review', 'paid', 'rejected'],
    default: 'pending_review'
  },
  walletTransactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TranscriptionWalletTransaction'
  },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  reviewNote: { type: String, trim: true, maxlength: 500, default: '' },
  mpesaReceipt: { type: String, trim: true, uppercase: true }
}, { timestamps: true, versionKey: false });

schema.index(
  { mpesaReceipt: 1 },
  { unique: true, partialFilterExpression: { mpesaReceipt: { $type: 'string' } } }
);
schema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.models.TranscriptionWithdrawal ||
  mongoose.model('TranscriptionWithdrawal', schema);
