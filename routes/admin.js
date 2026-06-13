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

// Deactivate a user (data-safe "delete"). We NEVER hard-delete the user or destroy their
// activity ledger / daily summaries — that is what permanently lost Sunil's 15,002 count.
// Instead we mark the account 'rejected' (which blocks login) while keeping every row, so
// the count is fully recoverable: an admin can re-approve and the totalCount is intact.
router.delete('/users/:userId', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User } = getModels();
    const { userId } = req.params;

    let user;
    if (dbFactory.isMongoDB()) {
      user = await User.findById(userId);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      user = await User.findByIdAndUpdate(userId, { status: 'rejected' }, { new: true });
    } else {
      user = await User.findByPk(userId);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      await User.update({ status: 'rejected' }, { where: { id: userId } });
      user = await User.findByPk(userId);
    }

    res.json({
      success: true,
      message: 'User deactivated. Their count and history are preserved — re-approve to restore.',
      user,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Restore every user's totalCount from the immutable activity ledger (never lowers it).
// One-shot repair tool to heal any account whose cached count drifted below its real
// history — e.g. after the old destructive bugs. Safe to run repeatedly.
router.post('/reconcile-counts', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User, Activity } = getModels();
    const results = { checked: 0, restored: 0, details: [] };

    if (dbFactory.isMongoDB()) {
      const users = await User.find({});
      for (const u of users) {
        results.checked += 1;
        const agg = await Activity.aggregate([
          { $match: { userId: u._id, activityType: 'COUNT_INCREMENT' } },
          { $group: { _id: null, total: { $sum: '$count' } } },
        ]);
        const ledger = (agg && agg[0] && agg[0].total) || 0;
        if (ledger > Number(u.totalCount || 0)) {
          results.details.push({ id: u._id, mobile: u.mobile, from: u.totalCount, to: ledger });
          u.totalCount = ledger;
          await u.save();
          results.restored += 1;
        }
      }
    } else {
      const users = await User.findAll();
      for (const u of users) {
        results.checked += 1;
        const ledger = (await Activity.sum('count', {
          where: { userId: u.id, activityType: 'COUNT_INCREMENT' },
        })) || 0;
        if (ledger > Number(u.totalCount || 0)) {
          results.details.push({ id: u.id, mobile: u.mobile, from: u.totalCount, to: ledger });
          await User.update({ totalCount: ledger }, { where: { id: u.id } });
          results.restored += 1;
        }
      }
    }

    res.json({ success: true, ...results });
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

// Update slogan
router.put('/slogans/:sloganId', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { Slogan } = getModels();
    const sloganId = req.params.sloganId;
    const appId = req.body.appId || 'ram-bank';
    const hi = String(req.body.hi || '').trim();
    const en = String(req.body.en || '').trim();

    if (!hi || !en) {
      return res.status(400).json({ success: false, message: 'Both Hindi and English slogans are required' });
    }

    if (dbFactory.isMongoDB()) {
      const slogan = await Slogan.findOneAndUpdate(
        { _id: sloganId, appId },
        { $set: { hi, en } },
        { new: true }
      );

      if (!slogan) {
        return res.status(404).json({ success: false, message: 'Slogan not found' });
      }

      const slogans = await Slogan.find({ appId }).sort({ createdAt: -1 });
      return res.json({ success: true, slogans });
    }

    const slogan = await Slogan.findByPk(sloganId);
    if (!slogan || slogan.appId !== appId) {
      return res.status(404).json({ success: false, message: 'Slogan not found' });
    }

    slogan.hi = hi;
    slogan.en = en;
    await slogan.save();

    const slogans = await Slogan.findAll({
      where: { appId },
      order: [['createdAt', 'DESC']],
    });

    res.json({ success: true, slogans });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete slogan
router.delete('/slogans/:sloganId', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { Slogan } = getModels();
    const sloganId = req.params.sloganId;
    const appId = req.query.appId || 'ram-bank';

    if (dbFactory.isMongoDB()) {
      const slogan = await Slogan.findOneAndDelete({ _id: sloganId, appId });
      if (!slogan) {
        return res.status(404).json({ success: false, message: 'Slogan not found' });
      }

      const slogans = await Slogan.find({ appId }).sort({ createdAt: -1 });
      return res.json({ success: true, slogans });
    }

    const slogan = await Slogan.findByPk(sloganId);
    if (!slogan || slogan.appId !== appId) {
      return res.status(404).json({ success: false, message: 'Slogan not found' });
    }

    await slogan.destroy();

    const slogans = await Slogan.findAll({
      where: { appId },
      order: [['createdAt', 'DESC']],
    });

    res.json({ success: true, slogans });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Chant summary report (weekly / monthly / yearly) — aggregates DailySummary by period
router.get('/reports/chant-summary', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User, DailySummary } = getModels();
    const {
      type = 'weekly',
      periodStart,
      periodEnd,
      appId,
      userId,
      bucket = 'day',
      topN: topNRaw,
    } = req.query;

    if (!periodStart || !periodEnd) {
      return res.status(400).json({ success: false, message: 'periodStart and periodEnd are required (YYYY-MM-DD)' });
    }
    const start = moment(periodStart, 'YYYY-MM-DD', true);
    const end = moment(periodEnd, 'YYYY-MM-DD', true);
    if (!start.isValid() || !end.isValid() || end.isBefore(start)) {
      return res.status(400).json({ success: false, message: 'Invalid period range' });
    }
    const normalizedType = ['weekly', 'monthly', 'yearly'].includes(type) ? type : 'weekly';
    const normalizedBucket = ['day', 'week', 'month'].includes(bucket) ? bucket : 'day';
    // topN: integer >= 1 caps the response to top-N rows by totalCount; 0 / missing means no cap.
    const parsedTopN = parseInt(topNRaw, 10);
    const topN = Number.isFinite(parsedTopN) && parsedTopN > 0 ? parsedTopN : 0;

    const bucketLabel = (dateStr) => {
      const m = moment(dateStr, 'YYYY-MM-DD');
      if (!m.isValid()) return dateStr;
      if (normalizedBucket === 'day') return m.format('YYYY-MM-DD');
      if (normalizedBucket === 'week') return `${m.isoWeekYear()}-W${String(m.isoWeek()).padStart(2, '0')}`;
      return m.format('YYYY-MM');
    };

    const startStr = start.format('YYYY-MM-DD');
    const endStr = end.format('YYYY-MM-DD');

    let rows = [];
    let totalCount = 0;
    let activeUsersSet = new Set();

    if (dbFactory.isMongoDB()) {
      const userMatch = { ...(appId && { appId }) };
      const allUsers = userId
        ? await User.find({ _id: userId, ...(appId && { appId }) })
        : await User.find(userMatch);

      const summaryMatch = {
        date: { $gte: startStr, $lte: endStr },
      };
      if (userId) summaryMatch.userId = userId;

      const summaries = await DailySummary.find(summaryMatch);

      const byUser = new Map();
      summaries.forEach((s) => {
        const uid = String(s.userId);
        const count = Number(s.dailyCount || 0);
        if (!byUser.has(uid)) byUser.set(uid, { total: 0, buckets: new Map() });
        const entry = byUser.get(uid);
        entry.total += count;
        const label = bucketLabel(s.date);
        entry.buckets.set(label, (entry.buckets.get(label) || 0) + count);
        if (count > 0) activeUsersSet.add(uid);
      });

      rows = allUsers
        .filter((u) => !appId || u.appId === appId)
        .map((u) => {
          const uid = String(u._id);
          const entry = byUser.get(uid) || { total: 0, buckets: new Map() };
          const buckets = Array.from(entry.buckets.entries())
            .sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .map(([label, count]) => ({ label, count }));
          totalCount += entry.total;
          return {
            userId: uid,
            name: u.name || '',
            mobile: u.mobile || '',
            email: u.email || '',
            status: u.status || 'pending',
            appId: u.appId || null,
            registeredDate: u.createdAt || null,
            totalCount: entry.total,
            buckets,
          };
        })
        // In single-user mode keep the row even if zero (admin explicitly picked them);
        // otherwise drop zero-count users so the payload only carries meaningful rows.
        .filter((r) => (userId ? true : r.totalCount > 0));
    } else {
      const userWhere = { ...(appId && { appId }) };
      if (userId) userWhere.id = userId;
      const allUsers = await User.findAll({ where: userWhere });

      const summaryWhere = { date: { [Op.between]: [startStr, endStr] } };
      if (userId) summaryWhere.userId = userId;
      const summaries = await DailySummary.findAll({ where: summaryWhere });

      const byUser = new Map();
      summaries.forEach((s) => {
        const uid = String(s.userId);
        const count = Number(s.dailyCount || 0);
        if (!byUser.has(uid)) byUser.set(uid, { total: 0, buckets: new Map() });
        const entry = byUser.get(uid);
        entry.total += count;
        const label = bucketLabel(s.date);
        entry.buckets.set(label, (entry.buckets.get(label) || 0) + count);
        if (count > 0) activeUsersSet.add(uid);
      });

      rows = allUsers
        .map((u) => {
          const uid = String(u.id);
          const entry = byUser.get(uid) || { total: 0, buckets: new Map() };
          const buckets = Array.from(entry.buckets.entries())
            .sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .map(([label, count]) => ({ label, count }));
          totalCount += entry.total;
          return {
            userId: uid,
            name: u.name || '',
            mobile: u.mobile || '',
            email: u.email || '',
            status: u.status || 'pending',
            appId: u.appId || null,
            registeredDate: u.createdAt || null,
            totalCount: entry.total,
            buckets,
          };
        })
        .filter((r) => (userId ? true : r.totalCount > 0));
    }

    rows.sort((a, b) => b.totalCount - a.totalCount);

    const fullRowCount = rows.length;
    const limitedRows = topN > 0 ? rows.slice(0, topN) : rows;

    res.json({
      success: true,
      meta: {
        type: normalizedType,
        bucket: normalizedBucket,
        periodStart: startStr,
        periodEnd: endStr,
        appId: appId || null,
        scope: userId ? 'single' : 'all',
        generatedAt: new Date().toISOString(),
      },
      totals: {
        totalUsers: fullRowCount,
        totalCount,
        activeUsers: activeUsersSet.size,
        truncatedRows: fullRowCount - limitedRows.length,
      },
      rows: limitedRows,
    });
  } catch (error) {
    console.error('🔴 Error generating chant summary report:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
