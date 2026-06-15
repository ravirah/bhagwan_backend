const express = require('express');
const router = express.Router();
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const getModels = require('../models');
const dbFactory = require('../config/database');
const moment = require('moment');
const { Op, QueryTypes } = require('sequelize');

// Append-only audit trail of admin actions: who (admin username), what (action),
// on whom (target user/mobile), from where (IP), and when. Never throws into the
// caller — auditing must not block the action it records.
async function logAdminAction(req, action, { targetUserId = null, targetMobile = null, details = {} } = {}) {
  try {
    const { AuditLog } = getModels();
    if (!AuditLog) return;
    const adminUser = (req.user && (req.user.username || req.user.name)) || 'unknown-admin';
    const ipAddress = (req.headers && req.headers['x-forwarded-for']) || req.ip || null;
    const payload = { adminUser, action, targetUserId: targetUserId == null ? null : String(targetUserId), targetMobile, details, ipAddress };
    if (dbFactory.isMongoDB()) {
      await AuditLog.create(payload);
    } else {
      // SQL targetUserId column is INTEGER; coerce or null.
      const numericTarget = Number(targetUserId);
      await AuditLog.create({ ...payload, targetUserId: Number.isFinite(numericTarget) ? numericTarget : null });
    }
  } catch (e) {
    console.error('audit log error:', e.message);
  }
}

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
    await logAdminAction(req, 'STATUS_CHANGE', { targetUserId: user._id || user.id, targetMobile: user.mobile, details: { status } });

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

    await logAdminAction(req, 'EDIT_USER', { targetUserId: user._id || user.id, targetMobile: user.mobile, details: { name, mobile, email } });
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

    await logAdminAction(req, 'DEACTIVATE_USER', { targetUserId: user._id || user.id, targetMobile: user.mobile, details: { previousStatus: 'see history' } });
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

    await logAdminAction(req, 'RECONCILE_COUNTS', { details: { checked: results.checked, restored: results.restored } });
    res.json({ success: true, ...results });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Forensic: find ORPHANED activity/summary rows — those whose userId no longer exists in
// the users table (i.e. the user was deleted but their history survived). Their
// COUNT_INCREMENT sum / totalCount snapshot reveals a deleted account's userId and count.
// Read-only. Optional ?appId= and ?minCount= filters to narrow the candidates.
router.get('/orphans', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User } = getModels();
    const appId = req.query.appId ? String(req.query.appId).trim() : null;
    const minCount = Number(req.query.minCount) || 0;

    if (dbFactory.isMongoDB()) {
      const { Activity, DailySummary } = getModels();
      const userIds = (await User.find({}, { _id: 1 })).map((u) => String(u._id));
      const idSet = new Set(userIds);
      const acts = await Activity.aggregate([
        { $group: { _id: { userId: '$userId', appId: '$appId' },
          activityRows: { $sum: 1 },
          ledgerSum: { $sum: { $cond: [{ $eq: ['$activityType', 'COUNT_INCREMENT'] }, '$count', 0] } },
          firstAt: { $min: '$timestamp' }, lastAt: { $max: '$timestamp' } } },
      ]);
      const orphanActivities = acts
        .filter((a) => !idSet.has(String(a._id.userId)))
        .map((a) => ({ userId: a._id.userId, appId: a._id.appId, activityRows: a.activityRows, ledgerSum: a.ledgerSum, firstAt: a.firstAt, lastAt: a.lastAt }))
        .filter((a) => (!appId || a.appId === appId) && a.ledgerSum >= minCount)
        .sort((x, y) => y.ledgerSum - x.ledgerSum);
      return res.json({ success: true, db: 'mongodb', orphanActivities, orphanSummaries: [] });
    }

    const sequelize = User.sequelize;
    const orphanActivities = await sequelize.query(
      `SELECT a.userId, a.appId,
              COUNT(*) AS activityRows,
              COALESCE(SUM(CASE WHEN a.activityType='COUNT_INCREMENT' THEN a.count ELSE 0 END),0) AS ledgerSum,
              MIN(a.timestamp) AS firstAt, MAX(a.timestamp) AS lastAt
       FROM activities a
       LEFT JOIN users u ON u.id = a.userId
       WHERE u.id IS NULL
       GROUP BY a.userId, a.appId
       HAVING ledgerSum >= :minCount
       ORDER BY ledgerSum DESC`,
      { type: QueryTypes.SELECT, replacements: { minCount } }
    );
    const orphanSummaries = await sequelize.query(
      `SELECT s.userId, s.appId,
              COUNT(*) AS dayRows,
              MAX(s.totalCount) AS maxTotalSnapshot, MAX(s.dailyCount) AS bestDay,
              MIN(s.date) AS firstDate, MAX(s.date) AS lastDate
       FROM dailysummaries s
       LEFT JOIN users u ON u.id = s.userId
       WHERE u.id IS NULL
       GROUP BY s.userId, s.appId
       HAVING maxTotalSnapshot >= :minCount
       ORDER BY maxTotalSnapshot DESC`,
      { type: QueryTypes.SELECT, replacements: { minCount } }
    );
    // Also report the id range + existing ids so a deletion GAP is visible.
    const idRows = await sequelize.query('SELECT id FROM users ORDER BY id', { type: QueryTypes.SELECT });
    const ids = idRows.map((r) => r.id);

    res.json({
      success: true,
      db: 'mysql',
      filters: { appId, minCount },
      orphanActivities: appId ? orphanActivities.filter((o) => o.appId === appId) : orphanActivities,
      orphanSummaries: appId ? orphanSummaries.filter((o) => o.appId === appId) : orphanSummaries,
      existingUserIds: ids,
      note: 'orphan* rows belong to deleted users. A high ledgerSum/maxTotalSnapshot near 15,002 in appId ram-bank, ending ~late May, is likely Sunil.',
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Audited manual count correction — restores a count lost outside the ledger (e.g.
// recovered from a user's device after a destructive delete). Records old→new + reason.
router.put('/users/:userId/set-count', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User } = getModels();
    const { userId } = req.params;
    const newTotal = Math.floor(Number(req.body.totalCount));
    if (!Number.isFinite(newTotal) || newTotal < 0) {
      return res.status(400).json({ success: false, message: 'totalCount must be a non-negative number' });
    }
    let user;
    if (dbFactory.isMongoDB()) user = await User.findById(userId);
    else user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const oldTotal = Number(user.totalCount || 0);
    if (dbFactory.isMongoDB()) { user.totalCount = newTotal; await user.save(); }
    else { await User.update({ totalCount: newTotal }, { where: { id: user.id } }); user = await User.findByPk(user.id); }

    await logAdminAction(req, 'SET_COUNT', {
      targetUserId: user._id || user.id, targetMobile: user.mobile,
      details: { from: oldTotal, to: newTotal, reason: req.body.reason || null },
    });
    res.json({ success: true, user, from: oldTotal, to: newTotal });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// View the admin audit trail (who did what, when). Newest first.
router.get('/audit-logs', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { AuditLog } = getModels();
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    let logs = [];
    if (dbFactory.isMongoDB()) {
      logs = await AuditLog.find({}).sort({ createdAt: -1 }).limit(limit);
    } else {
      logs = await AuditLog.findAll({ order: [['createdAt', 'DESC']], limit });
    }
    res.json({ success: true, logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Diagnose a user by mobile: returns EVERY matching user row (to reveal duplicates) plus
// each one's activity/summary counts. Settles "was this user deleted, or did a duplicate
// 0-count row get created?" — read-only, no side effects.
router.get('/diagnose-user', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User, Activity, DailySummary, AuditLog } = getModels();
    const mobile = String(req.query.mobile == null ? '' : req.query.mobile).trim();
    if (!mobile) return res.status(400).json({ success: false, message: 'mobile query param required' });

    let users = [];
    if (dbFactory.isMongoDB()) {
      users = await User.find({ mobile: { $regex: mobile, $options: 'i' } });
    } else {
      users = await User.findAll({ where: { mobile: { [Op.like]: `%${mobile}%` } } });
    }

    const report = [];
    for (const u of users) {
      const uid = u._id || u.id;
      let ledger = 0, activityRows = 0, summaryRows = 0;
      if (dbFactory.isMongoDB()) {
        activityRows = await Activity.countDocuments({ userId: uid });
        summaryRows = await DailySummary.countDocuments({ userId: uid });
        const agg = await Activity.aggregate([
          { $match: { userId: uid, activityType: 'COUNT_INCREMENT' } },
          { $group: { _id: null, total: { $sum: '$count' } } },
        ]);
        ledger = (agg && agg[0] && agg[0].total) || 0;
      } else {
        activityRows = await Activity.count({ where: { userId: uid } });
        summaryRows = await DailySummary.count({ where: { userId: uid } });
        ledger = (await Activity.sum('count', { where: { userId: uid, activityType: 'COUNT_INCREMENT' } })) || 0;
      }
      report.push({
        id: uid, name: u.name, mobile: u.mobile, appId: u.appId, status: u.status,
        totalCount: u.totalCount, createdAt: u.createdAt,
        activityRows, summaryRows, ledgerSum: ledger,
      });
    }

    // Surface any audit entries that mention this mobile.
    let relatedAudit = [];
    try {
      if (dbFactory.isMongoDB()) {
        relatedAudit = await AuditLog.find({ targetMobile: { $regex: mobile, $options: 'i' } }).sort({ createdAt: -1 }).limit(50);
      } else {
        relatedAudit = await AuditLog.findAll({ where: { targetMobile: { [Op.like]: `%${mobile}%` } }, order: [['createdAt', 'DESC']], limit: 50 });
      }
    } catch (_) { /* audit table may be brand new/empty */ }

    res.json({
      success: true,
      mobile,
      matchingUsers: report,
      interpretation: report.length > 1
        ? 'Multiple rows for this mobile → duplicate created by a lookup miss (no human deletion).'
        : (report.length === 1 && report[0].totalCount === 0 && report[0].ledgerSum > 0
            ? 'Single row at 0 but ledger has counts → totalCount was reset; reconcile will restore it.'
            : (report.length === 1
                ? 'Single row. Compare totalCount vs ledgerSum to judge if a reset occurred.'
                : 'No rows found — the user record was hard-deleted (recover from device or backup).')),
      relatedAudit,
    });
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

// Server-side राम-repetition PDF. Generates ONE complete PDF with EVERY राम written,
// streamed via PDFKit — no WebView, so it never hits the on-device expo-print memory
// wall that failed at large counts. Same query/params as /reports/chant-summary.
router.get('/reports/ram-pdf', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User, DailySummary } = getModels();
    const { periodStart, periodEnd, appId, userId, topN: topNRaw } = req.query;
    if (!periodStart || !periodEnd) {
      return res.status(400).json({ success: false, message: 'periodStart and periodEnd are required (YYYY-MM-DD)' });
    }
    const start = moment(periodStart, 'YYYY-MM-DD', true);
    const end = moment(periodEnd, 'YYYY-MM-DD', true);
    if (!start.isValid() || !end.isValid() || end.isBefore(start)) {
      return res.status(400).json({ success: false, message: 'Invalid period range' });
    }
    const startStr = start.format('YYYY-MM-DD');
    const endStr = end.format('YYYY-MM-DD');
    const parsedTopN = parseInt(topNRaw, 10);
    const topN = Number.isFinite(parsedTopN) && parsedTopN > 0 ? parsedTopN : 0;

    let rows = [];
    let totalCount = 0;

    if (dbFactory.isMongoDB()) {
      const userMatch = { ...(appId && { appId }) };
      const allUsers = userId ? await User.find({ _id: userId, ...(appId && { appId }) }) : await User.find(userMatch);
      const summaryMatch = { date: { $gte: startStr, $lte: endStr } };
      if (userId) summaryMatch.userId = userId;
      const summaries = await DailySummary.find(summaryMatch);
      const byUser = new Map();
      summaries.forEach((s) => {
        const uid = String(s.userId);
        byUser.set(uid, (byUser.get(uid) || 0) + Number(s.dailyCount || 0));
      });
      rows = allUsers
        .filter((u) => !appId || u.appId === appId)
        .map((u) => {
          const t = byUser.get(String(u._id)) || 0;
          totalCount += t;
          return { userId: String(u._id), name: u.name || '', mobile: u.mobile || '', email: u.email || '', totalCount: t };
        })
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
        byUser.set(uid, (byUser.get(uid) || 0) + Number(s.dailyCount || 0));
      });
      rows = allUsers
        .map((u) => {
          const t = byUser.get(String(u.id)) || 0;
          totalCount += t;
          return { userId: String(u.id), name: u.name || '', mobile: u.mobile || '', email: u.email || '', totalCount: t };
        })
        .filter((r) => (userId ? true : r.totalCount > 0));
    }

    rows.sort((a, b) => b.totalCount - a.totalCount);
    if (topN > 0) rows = rows.slice(0, topN);

    const { streamRamPdf } = require('../utils/ramPdf');
    const fname = `ram-naam-${userId ? 'user' : 'all'}-${startStr}_to_${endStr}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    streamRamPdf(res, {
      meta: { periodStart: startStr, periodEnd: endStr, scope: userId ? 'single' : 'all', generatedAt: new Date().toISOString() },
      totals: { totalCount },
      rows,
    }, {});
  } catch (error) {
    console.error('🔴 Error generating राम PDF:', error);
    if (!res.headersSent) res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
