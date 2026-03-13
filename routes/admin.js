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

// Update user status (approve / reject)
router.put('/users/:userId/status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User, Activity } = getModels();
    const { userId } = req.params;
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be approved or rejected' });
    }

    let user;
    if (dbFactory.isMongoDB()) {
      user = await User.findByIdAndUpdate(userId, { status }, { new: true });
    } else {
      await User.update({ status }, { where: { id: userId } });
      user = await User.findByPk(userId);
    }

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const activityType = status === 'approved' ? 'APPROVAL' : 'REJECTION';
    await Activity.create({
      userId: user._id || user.id,
      appId: user.appId,
      activityType,
      metadata: { updatedBy: 'admin', timestamp: new Date() }
    });

    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Edit user details
router.put('/users/:userId', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User } = getModels();
    const { userId } = req.params;
    const { name, mobile, email } = req.body;

    if (!name || !mobile) {
      return res.status(400).json({ success: false, message: 'Name and mobile are required' });
    }

    let user;
    if (dbFactory.isMongoDB()) {
      user = await User.findByIdAndUpdate(userId, { name, mobile, email }, { new: true });
    } else {
      await User.update({ name, mobile, email }, { where: { id: userId } });
      user = await User.findByPk(userId);
    }

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete user and all their data
router.delete('/users/:userId', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User, Activity, DailySummary } = getModels();
    const { userId } = req.params;

    let user;
    if (dbFactory.isMongoDB()) {
      user = await User.findById(userId);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      await Activity.deleteMany({ userId });
      await DailySummary.deleteMany({ userId });
      await User.findByIdAndDelete(userId);
    } else {
      user = await User.findByPk(userId);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      await Activity.destroy({ where: { userId } });
      await DailySummary.destroy({ where: { userId } });
      await User.destroy({ where: { id: userId } });
    }

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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

      const totalUsers = await User.countDocuments(userQuery);
      const activeToday = await Activity.countDocuments(activityQuery);
      const pendingUsers = await User.countDocuments({ ...userQuery, status: 'pending' });

      const summaryQuery = { date: today };
      if (appId) summaryQuery.appId = appId;

      const todaySummary = await DailySummary.aggregate([
        { $match: summaryQuery },
        { $group: { _id: null, totalCount: { $sum: '$dailyCount' } } }
      ]);

      const allTimeUsers = await User.find({ ...(appId && { appId }) }, 'totalCount name');
      const allTimeTotalCount = allTimeUsers.reduce((sum, u) => sum + (u.totalCount || 0), 0);

      // Top chanter all-time
      const topAllTime = await User.findOne(userQuery).sort({ totalCount: -1 }).select('name totalCount');

      // Top chanter today
      const topTodayAgg = await DailySummary.aggregate([
        { $match: summaryQuery },
        { $sort: { dailyCount: -1 } },
        { $limit: 1 }
      ]);
      let topToday = null;
      if (topTodayAgg.length > 0) {
        const topUser = await User.findById(topTodayAgg[0].userId, 'name');
        topToday = { name: topUser?.name || 'Unknown', count: topTodayAgg[0].dailyCount };
      }

      stats = {
        totalUsers,
        activeToday,
        pendingUsers,
        todayTotalCount: todaySummary[0]?.totalCount || 0,
        allTimeTotalCount,
        topChanterToday: topToday,
        topChanterAllTime: topAllTime ? { name: topAllTime.name, count: topAllTime.totalCount } : null,
      };
    } else {
      const userWhere = { ...(appId && { appId }) };
      const activityWhere = {
        activityType: 'LOGIN',
        timestamp: { [Op.gte]: moment().startOf('day').toDate() },
        ...(appId && { appId })
      };

      const totalUsers = await User.count({ where: userWhere });
      const activeToday = await Activity.count({ where: activityWhere });
      const pendingUsers = await User.count({ where: { ...userWhere, status: 'pending' } });

      const summaryWhere = { date: today };
      if (appId) summaryWhere.appId = appId;

      const todaySummary = await DailySummary.sum('dailyCount', {
        where: summaryWhere
      }) || 0;

      const allTimeTotalCount = await User.sum('totalCount', { where: userWhere }) || 0;

      // Top chanter all-time
      const topAllTimeUser = await User.findOne({
        where: userWhere,
        order: [['totalCount', 'DESC']],
        attributes: ['name', 'totalCount'],
      });

      // Top chanter today
      const topTodaySummary = await DailySummary.findOne({
        where: summaryWhere,
        order: [['dailyCount', 'DESC']],
        include: [{ model: User, attributes: ['name'] }],
      });

      stats = {
        totalUsers,
        activeToday,
        pendingUsers,
        todayTotalCount: todaySummary,
        allTimeTotalCount,
        topChanterToday: topTodaySummary ? { name: topTodaySummary.User?.name || 'Unknown', count: topTodaySummary.dailyCount } : null,
        topChanterAllTime: topAllTimeUser ? { name: topAllTimeUser.name, count: topAllTimeUser.totalCount } : null,
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

// Get slogans for an app
router.get('/slogans', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { Slogan } = getModels();
    const appId = req.query.appId || 'ram-bank';

    let slogans;
    if (dbFactory.isMongoDB()) {
      slogans = await Slogan.find({ appId }).sort({ createdAt: -1 });
    } else {
      slogans = await Slogan.findAll({
        where: { appId },
        order: [['createdAt', 'DESC']],
      });
    }

    res.json({ success: true, slogans });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Add slogan for an app
router.post('/slogans', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { Slogan } = getModels();
    const appId = req.body.appId || 'ram-bank';
    const hi = String(req.body.hi || '').trim();
    const en = String(req.body.en || '').trim();

    if (!hi || !en) {
      return res.status(400).json({ success: false, message: 'Both Hindi and English slogans are required' });
    }

    if (dbFactory.isMongoDB()) {
      await Slogan.findOneAndUpdate(
        { appId, hi },
        { $set: { en }, $setOnInsert: { appId, hi } },
        { upsert: true, new: true }
      );
      const slogans = await Slogan.find({ appId }).sort({ createdAt: -1 });
      return res.json({ success: true, slogans });
    }

    const [slogan] = await Slogan.findOrCreate({
      where: { appId, hi },
      defaults: { appId, hi, en },
    });

    if (slogan.en !== en) {
      slogan.en = en;
      await slogan.save();
    }

    const slogans = await Slogan.findAll({
      where: { appId },
      order: [['createdAt', 'DESC']],
    });

    res.json({ success: true, slogans });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
