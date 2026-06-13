const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const getModels = require('../models');

// The Activity table is the immutable ledger of every counted राम (one COUNT_INCREMENT
// row per sync, carrying its delta). A user's totalCount is just a derived cache. If that
// cache ever drifts BELOW the ledger sum — a bad write, a recreated row, a glitch — we
// restore it from the ledger so a user's count can never be silently lost. We only ever
// raise it, never lower, so a legitimately higher cache is preserved.
async function reconcileTotalFromLedger(models, dbFactory, user) {
  if (!user) return user;
  try {
    const { Activity, User } = models;
    let ledgerSum = 0;
    if (dbFactory.isMongoDB()) {
      const agg = await Activity.aggregate([
        { $match: { userId: user._id || user.id, activityType: 'COUNT_INCREMENT' } },
        { $group: { _id: null, total: { $sum: '$count' } } },
      ]);
      ledgerSum = (agg && agg[0] && agg[0].total) || 0;
    } else {
      ledgerSum = (await Activity.sum('count', {
        where: { userId: user.id, activityType: 'COUNT_INCREMENT' },
      })) || 0;
    }
    const current = Number(user.totalCount || 0);
    if (ledgerSum > current) {
      console.warn(`🛟 Restoring totalCount for user ${user.id || user._id} from ledger: ${current} → ${ledgerSum}`);
      if (dbFactory.isMongoDB()) {
        user.totalCount = ledgerSum;
        await user.save();
      } else {
        await User.update({ totalCount: ledgerSum }, { where: { id: user.id } });
        user.totalCount = ledgerSum;
      }
    }
  } catch (e) {
    console.error('reconcileTotalFromLedger error:', e.message);
  }
  return user;
}

/**
 * AUTH ROUTES - Multi-App Support
 *
 * All authentication includes 'appId' to scope users to their app.
 * Default appId: 'ram-bank'
 * Login/Register looks up by mobile + appId. If found → login; if not → auto-create.
 */

// User Login/Register
router.post('/login', async (req, res) => {
  try {
    // Normalize the unique key so trailing spaces / casing can never cause the lookup to
    // miss an existing user and silently create a fresh 0-count duplicate.
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : req.body.name;
    const mobile = String(req.body.mobile == null ? '' : req.body.mobile).trim();
    const appId = String(req.body.appId == null || req.body.appId === '' ? 'ram-bank' : req.body.appId).trim();
    const { User, Activity } = getModels();

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Name is required'
      });
    }

    if (!mobile) {
      return res.status(400).json({
        success: false,
        message: 'Mobile number is required'
      });
    }

    const dbFactory = require('../config/database');
    let user;
    let isNewUser = false;

    if (dbFactory.isMongoDB()) {
      // Look up user by mobile within this app (mobile is the unique key)
      user = await User.findOne({ mobile, appId });
      if (!user) {
        // New user - auto-create account with pending status
        user = new User({ name, mobile, appId, status: 'pending' });
        await user.save();
        isNewUser = true;
      } else if (name && user.name !== name) {
        // Existing user logging in with updated name — update it
        user.name = name;
        await user.save();
      }
    } else {
      // SQL databases — mobile is the unique key
      user = await User.findOne({ where: { mobile, appId } });
      if (!user) {
        // New user - auto-create account with pending status
        user = await User.create({ name, mobile, appId, status: 'pending' });
        isNewUser = true;
      } else if (name && user.name !== name) {
        // Existing user logging in with updated name — update it
        await User.update({ name }, { where: { id: user.id } });
        user = await User.findByPk(user.id);
      }
    }

    // Log activity
    if (dbFactory.isMongoDB()) {
      await Activity.create({
        userId: user._id || user.id,
        appId: user.appId,
        activityType: isNewUser ? 'REGISTER' : 'LOGIN',
        metadata: { timestamp: new Date() }
      });
    } else {
      await Activity.create({
        userId: user.id,
        appId: user.appId,
        activityType: isNewUser ? 'REGISTER' : 'LOGIN',
        metadata: { timestamp: new Date() }
      });
    }

    // Self-heal: make sure the stored totalCount is never below the activity ledger.
    if (!isNewUser) {
      user = await reconcileTotalFromLedger(getModels(), dbFactory, user);
    }

    // Block non-approved users
    if (user.status !== 'approved') {
      const message = user.status === 'rejected'
        ? 'Your account has been rejected. Please contact admin.'
        : 'Your account is pending admin approval. Please contact admin.';
      return res.json({
        success: true,
        approved: false,
        status: user.status,
        message,
        user: {
          id: user._id || user.id,
          name: user.name,
          mobile: user.mobile,
          status: user.status
        }
      });
    }

    // Generate token
    const token = jwt.sign(
      {
        userId: user._id || user.id,
        name: user.name,
        isAdmin: false
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      approved: true,
      token,
      user: {
        id: user._id || user.id,
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        totalCount: user.totalCount,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Lookup user by mobile — returns name if user exists (no side-effects)
router.post('/lookup', async (req, res) => {
  try {
    const mobile = String(req.body.mobile == null ? '' : req.body.mobile).trim();
    const appId = String(req.body.appId == null || req.body.appId === '' ? 'ram-bank' : req.body.appId).trim();

    if (!mobile) {
      return res.status(400).json({ success: false, message: 'Mobile number is required' });
    }

    const { User } = getModels();
    const dbFactory = require('../config/database');

    let user;
    if (dbFactory.isMongoDB()) {
      user = await User.findOne({ mobile, appId });
    } else {
      user = await User.findOne({ where: { mobile, appId } });
    }

    if (user) {
      return res.json({
        success: true,
        exists: true,
        user: {
          name: user.name,
          mobile: user.mobile,
          status: user.status,
        },
      });
    }

    return res.json({ success: true, exists: false });
  } catch (error) {
    console.error('Lookup error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Admin Login
router.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (username !== process.env.ADMIN_USERNAME || 
        password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    const token = jwt.sign(
      { 
        username, 
        isAdmin: true 
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      admin: { username }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

module.exports = router;
