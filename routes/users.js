const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const getModels = require('../models');
const dbFactory = require('../config/database');

// Get user profile
router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const { User } = getModels();
    
    let user;
    if (dbFactory.isMongoDB()) {
      user = await User.findById(req.user.userId);
    } else {
      user = await User.findByPk(req.user.userId);
    }

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    res.json({
      success: true,
      user: {
        id: user._id || user.id,
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        totalCount: user.totalCount,
        lastActiveDate: user.lastActiveDate
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Update user profile
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { User, Activity } = getModels();
    const { name, email, mobile } = req.body;

    let user;
    if (dbFactory.isMongoDB()) {
      user = await User.findByIdAndUpdate(
        req.user.userId,
        { name, email, mobile },
        { new: true }
      );
    } else {
      user = await User.findByPk(req.user.userId);
      await user.update({ name, email, mobile });
    }

    // Log activity
    await Activity.create({
      userId: req.user.userId,
      appId: user.appId,
      activityType: 'PROFILE_UPDATE',
      metadata: { changes: { name, email, mobile } }
    });

    res.json({
      success: true,
      user: {
        id: user._id || user.id,
        name: user.name,
        email: user.email,
        mobile: user.mobile
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

module.exports = router;
