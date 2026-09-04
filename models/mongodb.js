const mongoose = require('mongoose');
const defaultSlogans = require('../config/defaultSlogans');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    sparse: true,
    lowercase: true
  },
  mobile: {
    type: String,
    required: true
  },
  pin: {
    type: String,
    default: null
  },
  appId: {
    type: String,
    required: true,
    default: 'ram-bank',
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  totalCount: {
    type: Number,
    default: 0
  },
  lastActiveDate: {
    type: Date,
    default: Date.now
  },
  // Soft-delete marker (non-null = deleted: hidden from admin & blocked at login, data kept).
  deletedAt: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Create compound index for unique mobile per app
userSchema.index({ appId: 1, mobile: 1 }, { unique: true });

const activitySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  appId: {
    type: String,
    required: true,
    default: 'ram-bank',
    index: true
  },
  activityType: {
    type: String,
    required: true,
    enum: ['COUNT_INCREMENT', 'REGISTER', 'LOGIN', 'LOGOUT', 'PROFILE_UPDATE', 'DAILY_RESET', 'APPROVAL', 'REJECTION']
  },
  count: {
    type: Number,
    default: 0
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
});

const dailySummarySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  appId: {
    type: String,
    required: true,
    default: 'ram-bank',
    index: true
  },
  date: {
    type: String,
    required: true,
    index: true
  },
  dailyCount: {
    type: Number,
    default: 0
  },
  totalCount: {
    type: Number,
    default: 0
  },
  streak: {
    type: Number,
    default: 0
  },
  firstCountAt: {
    type: Date,
    default: null
  },
  lastCountAt: {
    type: Date,
    default: null
  },
  activeDurationSeconds: {
    type: Number,
    default: 0
  },
  // Portion of dailyCount that came from an admin recovery/backfill, not chanting.
  recoveryCount: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

dailySummarySchema.index({ userId: 1, date: 1 }, { unique: true });

const sloganSchema = new mongoose.Schema({
  appId: {
    type: String,
    required: true,
    default: 'ram-bank',
    index: true
  },
  hi: {
    type: String,
    required: true,
    trim: true
  },
  en: {
    type: String,
    required: true,
    trim: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

sloganSchema.index({ appId: 1, hi: 1 }, { unique: true });

const auditLogSchema = new mongoose.Schema({
  adminUser: { type: String, default: null },
  action: { type: String, required: true, index: true },
  targetUserId: { type: String, default: null, index: true },
  targetMobile: { type: String, default: null },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  ipAddress: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, index: true },
});

const adminCredentialSchema = new mongoose.Schema({
  username: { type: String, required: true },
  passwordHash: { type: String, required: true },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Activity = mongoose.model('Activity', activitySchema);
const DailySummary = mongoose.model('DailySummary', dailySummarySchema);
const Slogan = mongoose.models.Slogan || mongoose.model('Slogan', sloganSchema);
const AuditLog = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema);
const AdminCredential = mongoose.models.AdminCredential || mongoose.model('AdminCredential', adminCredentialSchema);

for (const [appId, slogans] of Object.entries(defaultSlogans)) {
  for (const slogan of slogans) {
    Slogan.findOneAndUpdate(
      { appId, hi: slogan.hi },
      { $setOnInsert: { appId, hi: slogan.hi, en: slogan.en } },
      { upsert: true, new: false }
    ).catch(() => {});
  }
}

module.exports = { User, Activity, DailySummary, Slogan, AuditLog, AdminCredential };



