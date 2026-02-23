const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const getModels = require('../models');
const dbFactory = require('../config/database');
const moment = require('moment');

// Add count activity
router.post('/add-count', authMiddleware, async (req, res) => {
  try {
    const { User, Activity, DailySummary } = getModels();
    const { count = 1 } = req.body;
    const today = moment().format('YYYY-MM-DD');

    // Update user total count
    let user;
    if (dbFactory.isMongoDB()) {
      user = await User.findByIdAndUpdate(
        req.user.userId,
        { 
          $inc: { totalCount: count },
          lastActiveDate: new Date()
        },
        { new: true }
      );
    } else {
      user = await User.findByPk(req.user.userId);
      user.totalCount += count;
      user.lastActiveDate = new Date();
      await user.save();
    }

    // Log activity
    await Activity.create({
      userId: req.user.userId,
      appId: user.appId,
      activityType: 'COUNT_INCREMENT',
      count,
      timestamp: new Date()
    });

    // Update daily summary
    if (dbFactory.isMongoDB()) {
      await DailySummary.findOneAndUpdate(
        { userId: req.user.userId, date: today },
        { 
          $inc: { dailyCount: count },
          $set: { 
            totalCount: user.totalCount,
            appId: user.appId
          }
        },
        { upsert: true, new: true }
      );
    } else {
      const [summary, created] = await DailySummary.findOrCreate({
        where: { userId: req.user.userId, date: today },
        defaults: { 
          userId: req.user.userId,
          appId: user.appId,
          date: today,
          dailyCount: count,
          totalCount: user.totalCount
        }
      });
      if (!created) {
        summary.dailyCount += count;
        summary.totalCount = user.totalCount;
        await summary.save();
      }
    }

    res.json({
      success: true,
      totalCount: user.totalCount,
      message: 'Count updated successfully'
    });
  } catch (error) {
    console.error('Add count error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Get user activities
router.get('/my-activities', authMiddleware, async (req, res) => {
  try {
    const { Activity } = getModels();
    const { limit = 50, page = 1 } = req.query;
    const skip = (page - 1) * limit;

    let activities;
    if (dbFactory.isMongoDB()) {
      activities = await Activity.find({ userId: req.user.userId })
        .sort({ timestamp: -1 })
        .limit(parseInt(limit))
        .skip(skip);
    } else {
      activities = await Activity.findAll({
        where: { userId: req.user.userId },
        order: [['timestamp', 'DESC']],
        limit: parseInt(limit),
        offset: skip
      });
    }

    res.json({
      success: true,
      activities
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Get daily summary
router.get('/daily-summary', authMiddleware, async (req, res) => {
  try {
    const { DailySummary } = getModels();
    const { days = 7 } = req.query;

    let summaries;
    if (dbFactory.isMongoDB()) {
      summaries = await DailySummary.find({ userId: req.user.userId })
        .sort({ date: -1 })
        .limit(parseInt(days));
    } else {
      summaries = await DailySummary.findAll({
        where: { userId: req.user.userId },
        order: [['date', 'DESC']],
        limit: parseInt(days)
      });
    }

    res.json({
      success: true,
      summaries
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

module.exports = router;
