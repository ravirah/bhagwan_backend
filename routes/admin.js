const express = require('express');
const router = express.Router();
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const getModels = require('../models');
const dbFactory = require('../config/database');
const moment = require('moment');
const { Op, QueryTypes } = require('sequelize');

// Get all users
router.get('/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User } = getModels();
    const { limit = 50, page = 1, search = '', appId } = req.query;
    const skip = (page - 1) * limit;

    let users;
    if (dbFactory.isMongoDB()) {
      const query = { ...(appId && { appId }) };
      
      if (search) {
        query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ];
      }
      
      users = await User.find(query)
        .sort({ lastActiveDate: -1 })
        .limit(parseInt(limit))
        .skip(skip);
    } else {
      const where = { ...(appId && { appId }) };
      
      if (search) {
        where[Op.or] = [
          { name: { [Op.like]: `%${search}%` } },
          { email: { [Op.like]: `%${search}%` } }
        ];
      }
      
      users = await User.findAll({
        where,
        order: [['lastActiveDate', 'DESC']],
        limit: parseInt(limit),
        offset: skip
      });
    }

    res.json({
      success: true,
      users,
      pagination: { page: parseInt(page), limit: parseInt(limit) }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Get user details with activities
router.get('/users/:userId', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User, Activity, DailySummary } = getModels();
    const { userId } = req.params;

    let user, activities, summaries;
    
    if (dbFactory.isMongoDB()) {
      user = await User.findById(userId);
      activities = await Activity.find({ userId })
        .sort({ timestamp: -1 })
        .limit(100);
      summaries = await DailySummary.find({ userId })
        .sort({ date: -1 })
        .limit(30);
    } else {
      user = await User.findByPk(userId);
      activities = await Activity.findAll({
        where: { userId },
        order: [['timestamp', 'DESC']],
        limit: 100
      });
      summaries = await DailySummary.findAll({
        where: { userId },
        order: [['date', 'DESC']],
        limit: 30
      });
    }

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    res.json({
      success: true,
      user,
      activities,
      summaries
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Get all activities
router.get('/activities', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { Activity } = getModels();
    const { limit = 100, page = 1, type = '', userId = '', appId } = req.query;
    const skip = (page - 1) * limit;

    let activities;
    if (dbFactory.isMongoDB()) {
      const query = {};
      if (type) query.activityType = type;
      if (userId) query.userId = userId;
      if (appId) query.appId = appId;
      
      activities = await Activity.find(query)
        .populate('userId', 'name email')
        .sort({ timestamp: -1 })
        .limit(parseInt(limit))
        .skip(skip);
    } else {
      const where = {};
      if (type) where.activityType = type;
      if (userId) where.userId = userId;
      if (appId) where.appId = appId;
      
      const { User } = getModels();
      activities = await Activity.findAll({
        where,
        include: [{ model: User, attributes: ['name', 'email'] }],
        order: [['timestamp', 'DESC']],
        limit: parseInt(limit),
        offset: skip
      });
    }

    res.json({
      success: true,
      activities,
      pagination: { page: parseInt(page), limit: parseInt(limit) }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Get dashboard statistics
router.get('/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User, Activity, DailySummary } = getModels();
    const { appId } = req.query;
    const today = moment().format('YYYY-MM-DD');

    console.log('📊 Stats endpoint called with appId:', appId);

    let stats;
    if (dbFactory.isMongoDB()) {
      const userQuery = { ...(appId && { appId }) };
      const activityQuery = { 
        activityType: 'LOGIN',
        timestamp: { $gte: moment().startOf('day').toDate() },
        ...(appId && { appId })
      };

      console.log('📊 MongoDB userQuery:', JSON.stringify(userQuery));

      const totalUsers = await User.countDocuments(userQuery);
      const activeToday = await Activity.countDocuments(activityQuery);
      
      // Now we can directly filter DailySummary by appId
      const summaryQuery = { date: today };
      if (appId) summaryQuery.appId = appId;
      
      const todaySummary = await DailySummary.aggregate([
        { $match: summaryQuery },
        { $group: { _id: null, totalCount: { $sum: '$dailyCount' } } }
      ]);
      
      stats = {
        totalUsers,
        activeToday,
        todayTotalCount: todaySummary[0]?.totalCount || 0
      };
    } else {
      const userWhere = { ...(appId && { appId }) };
      const activityWhere = {
        activityType: 'LOGIN',
        timestamp: { [Op.gte]: moment().startOf('day').toDate() },
        ...(appId && { appId })
      };
      
      console.log('📊 SQL userWhere:', JSON.stringify(userWhere));

      const totalUsers = await User.count({ where: userWhere });
      const activeToday = await Activity.count({ where: activityWhere });
      
      // Now we can directly filter DailySummary by appId
      const summaryWhere = { date: today };
      if (appId) summaryWhere.appId = appId;
      
      const todaySummary = await DailySummary.sum('dailyCount', {
        where: summaryWhere
      }) || 0;
      
      console.log('📊 Total users found:', totalUsers);
      console.log('📊 Today total count:', todaySummary);
      
      stats = {
        totalUsers,
        activeToday,
        todayTotalCount: todaySummary
      };
    }

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Get list of apps with user counts
router.get('/apps', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User } = getModels();
    
    let apps;
    if (dbFactory.isMongoDB()) {
      // MongoDB aggregation to get unique apps with counts
      apps = await User.aggregate([
        { $group: { 
          _id: '$appId', 
          userCount: { $sum: 1 }
        }},
        { $sort: { _id: 1 } }
      ]);
      
      apps = apps.map(app => ({
        appId: app._id,
        name: app._id, // Will be formatted on frontend
        userCount: app.userCount
      }));
    } else {
      // SQL query to get unique apps with counts
      const sequelize = dbFactory.getConnection();
      const results = await sequelize.query(
        'SELECT appId, COUNT(*) as userCount FROM users GROUP BY appId ORDER BY appId',
        { type: QueryTypes.SELECT }
      );
      
      apps = results.map(app => ({
        appId: app.appId,
        name: app.appId, // Will be formatted on frontend
        userCount: app.userCount
      }));
    }
    
    res.json({
      success: true,
      apps
    });
  } catch (error) {
    console.error('🔴 Error fetching apps:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

module.exports = router;
