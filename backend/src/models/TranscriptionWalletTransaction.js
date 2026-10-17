const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ['earning', 'withdrawal', 'adjustment', 'earning_reversal'],
    required: true
  },
  amountCents: {
    type: Number,
    required: true,
    min: 1,
    validate: Number.isSafeInteger
  },
  currency: { type: String, enum: ['USD'], default: 'USD', immutable: true },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'reversed'],
    default: 'pending'
  },
  reference: { type: String, required: true, unique: true },
  description: { type: String, trim: true, maxlength: 500, default: '' },
  transcriptionSubmissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TranscriptionSubmission'
  },
  transcriptionWithdrawalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TranscriptionWithdrawal'
  }
}, { timestamps: true, versionKey: false });

schema.index(
  { transcriptionSubmissionId: 1 },
  { unique: true, partialFilterExpression: { transcriptionSubmissionId: { $type: 'objectId' } } }
);
schema.index(
  { transcriptionWithdrawalId: 1 },
  { unique: true, partialFilterExpression: { transcriptionWithdrawalId: { $type: 'objectId' } } }
);
schema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.models.TranscriptionWalletTransaction ||
  mongoose.model('TranscriptionWalletTransaction', schema);
