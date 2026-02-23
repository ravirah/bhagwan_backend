const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const getModels = require('../models');

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
    const { name, mobile, appId = 'ram-bank' } = req.body;
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
      // Look up user by mobile within this app
      user = await User.findOne({ mobile, appId });
      if (!user) {
        // New user - auto-create account
        user = new User({ name, mobile, appId });
        await user.save();
        isNewUser = true;
      }
    } else {
      // SQL databases
      user = await User.findOne({ where: { mobile, appId } });
      if (!user) {
        // New user - auto-create account
        user = await User.create({ name, mobile, appId });
        isNewUser = true;
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
      token,
      user: {
        id: user._id || user.id,
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        totalCount: user.totalCount
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
