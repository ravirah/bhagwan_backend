const mongoose = require('mongoose');

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
  totalCount: {
    type: Number,
    default: 0
  },
  lastActiveDate: {
    type: Date,
    default: Date.now
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
  activityType: {
    type: String,
    required: true,
    enum: ['COUNT_INCREMENT', 'REGISTER', 'LOGIN', 'LOGOUT', 'PROFILE_UPDATE', 'DAILY_RESET']
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
  createdAt: {
    type: Date,
    default: Date.now
  }
});

dailySummarySchema.index({ userId: 1, date: 1 }, { unique: true });

const User = mongoose.model('User', userSchema);
const Activity = mongoose.model('Activity', activitySchema);
const DailySummary = mongoose.model('DailySummary', dailySummarySchema);

module.exports = { User, Activity, DailySummary };
