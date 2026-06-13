const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const getModels = require('../models');
const dbFactory = require('../config/database');
const moment = require('moment');

function getActiveDurationSeconds(firstCountAt, lastCountAt) {
  if (!firstCountAt || !lastCountAt) return 0;
  const start = moment(firstCountAt);
  const end = moment(lastCountAt);
  if (!start.isValid() || !end.isValid()) return 0;
  return Math.max(0, end.diff(start, 'seconds'));
}

// Add count activity
router.post('/add-count', authMiddleware, async (req, res) => {
  try {
    const { User, Activity, DailySummary } = getModels();
    const { count = 1 } = req.body;
    const now = new Date();
    const today = moment(now).format('YYYY-MM-DD');

    let user;
    if (dbFactory.isMongoDB()) {
      user = await User.findByIdAndUpdate(
        req.user.userId,
        {
          $inc: { totalCount: count },
          lastActiveDate: now
        },
        { new: true }
      );
    } else {
      user = await User.findByPk(req.user.userId);
      // Atomic DB-level increment (UPDATE ... SET totalCount = totalCount + count) so
      // concurrent requests can't read the same value and clobber each other.
      await user.increment({ totalCount: count });
      user.lastActiveDate = now;
      // Persist only the timestamp — re-saving the whole instance would write back a
      // stale in-memory totalCount and undo the atomic increment above.
      await user.save({ fields: ['lastActiveDate'] });
      await user.reload();
    }

    await Activity.create({
      userId: req.user.userId,
      appId: user.appId,
      activityType: 'COUNT_INCREMENT',
      count,
      timestamp: now
    });

    let summary;
    if (dbFactory.isMongoDB()) {
      summary = await DailySummary.findOneAndUpdate(
        { userId: req.user.userId, date: today },
        {
          $inc: { dailyCount: count },
          $set: {
            totalCount: user.totalCount,
            appId: user.appId,
            lastCountAt: now
          },
          $setOnInsert: {
            userId: req.user.userId,
            date: today,
            firstCountAt: now,
            createdAt: now
          },
          $min: { firstCountAt: now },
          $max: { lastCountAt: now }
        },
        { upsert: true, new: true }
      );

      summary.activeDurationSeconds = getActiveDurationSeconds(summary.firstCountAt, summary.lastCountAt);
      await summary.save();
    } else {
      const [foundSummary, created] = await DailySummary.findOrCreate({
        where: { userId: req.user.userId, date: today },
        defaults: {
          userId: req.user.userId,
          appId: user.appId,
          date: today,
          dailyCount: count,
          totalCount: user.totalCount,
          firstCountAt: now,
          lastCountAt: now,
          activeDurationSeconds: 0
        }
      });

      summary = foundSummary;
      if (!created) {
        // Atomic DB-level increment of the daily counter.
        await summary.increment({ dailyCount: count });
        const newFirstCountAt = summary.firstCountAt && new Date(summary.firstCountAt) < now ? summary.firstCountAt : now;
        summary.totalCount = user.totalCount;
        summary.appId = user.appId;
        summary.firstCountAt = newFirstCountAt;
        summary.lastCountAt = now;
        summary.activeDurationSeconds = getActiveDurationSeconds(newFirstCountAt, now);
        // Save only the metadata fields; dailyCount is owned by the atomic increment above.
        await summary.save({ fields: ['totalCount', 'appId', 'firstCountAt', 'lastCountAt', 'activeDurationSeconds'] });
        await summary.reload();
      }
    }

    res.json({
      success: true,
      totalCount: user.totalCount,
      todayCount: summary?.dailyCount || 0,
      firstCountAt: summary?.firstCountAt || null,
      lastCountAt: summary?.lastCountAt || null,
      activeDurationSeconds: summary?.activeDurationSeconds || 0,
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
