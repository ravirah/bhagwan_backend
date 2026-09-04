const express = require('express');
const router = express.Router();
const { authMiddleware, adminMiddleware, requireMinAdminAppVersion } = require('../middleware/auth');
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

// Enforce the invariant SUM(DailySummary.dailyCount) == canonicalTotal for a user by
// adding a single recovery DailySummary row for the gap (reports sum DailySummary, so
// without this a restored totalCount under-reports). Returns the gap added. THROWS on
// failure (callers surface a 500) — recovery must never silently leave a gap.
function resolveRecoveryDate(user, recoveryDate) {
  return (typeof recoveryDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(recoveryDate))
    ? recoveryDate
    : moment(user.createdAt || new Date()).format('YYYY-MM-DD');
}

async function backfillSummaryGap(models, user, canonicalTotal, recoveryDate, opts = {}) {
  const { DailySummary } = models;
  const uid = user._id || user.id;
  const date = resolveRecoveryDate(user, recoveryDate);
  const tx = opts.transaction ? { transaction: opts.transaction } : {};
  let summarySum = 0;
  if (dbFactory.isMongoDB()) {
    const agg = await DailySummary.aggregate([{ $match: { userId: uid } }, { $group: { _id: null, total: { $sum: '$dailyCount' } } }]);
    summarySum = (agg && agg[0] && agg[0].total) || 0;
  } else {
    summarySum = (await DailySummary.sum('dailyCount', { where: { userId: uid }, ...tx })) || 0;
  }
  const gap = canonicalTotal - summarySum;
  if (gap <= 0) return 0;
  if (dbFactory.isMongoDB()) {
    await DailySummary.findOneAndUpdate(
      { userId: uid, date },
      { $inc: { dailyCount: gap, recoveryCount: gap }, $set: { appId: user.appId, totalCount: canonicalTotal }, $setOnInsert: { userId: uid, date } },
      { upsert: true, new: true }
    );
  } else {
    const [row, created] = await DailySummary.findOrCreate({
      where: { userId: uid, date },
      defaults: { userId: uid, appId: user.appId, date, dailyCount: gap, recoveryCount: gap, totalCount: canonicalTotal },
      ...tx,
    });
    if (!created) {
      row.dailyCount = Number(row.dailyCount || 0) + gap;
      row.recoveryCount = Number(row.recoveryCount || 0) + gap;
      row.totalCount = canonicalTotal;
      await row.save(tx);
    }
  }
  return gap;
}

// Per-date ledger sums for a user ('YYYY-MM-DD' -> SUM of COUNT_INCREMENT). A summary row is
// never trimmed below its ledger sum: those counts are real, chanted events.
async function ledgerByDate(models, uid, opts = {}) {
  const { Activity } = models;
  const map = new Map();
  if (dbFactory.isMongoDB()) {
    const rows = await Activity.aggregate([
      { $match: { userId: uid, activityType: 'COUNT_INCREMENT' } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }, total: { $sum: '$count' } } },
    ]);
    for (const r of rows) map.set(r._id, Number(r.total) || 0);
  } else {
    const sequelize = dbFactory.getConnection();
    const rows = await sequelize.query(
      `SELECT DATE(timestamp) AS d, COALESCE(SUM(count),0) AS total FROM activities
        WHERE userId = :uid AND activityType = 'COUNT_INCREMENT' GROUP BY DATE(timestamp)`,
      { replacements: { uid }, type: QueryTypes.SELECT, transaction: opts.transaction }
    );
    for (const r of rows) map.set(moment(r.d).format('YYYY-MM-DD'), Number(r.total) || 0);
  }
  return map;
}

// Inverse of backfillSummaryGap. When SUM(DailySummary.dailyCount) EXCEEDS the target total
// (an admin LOWERED a count), take the excess back out of the rows that hold NON-ledger counts
// (recovery / backfill rows), preferring the recovery date, and never lowering any day below what
// its ledger proves was chanted. Without this a lowered total leaves a stale recovery row behind
// and the app shows a "Best day" larger than the Total.
// Returns { removed, unabsorbed, changes:[{date,before,after}] }. The per-row change list goes
// into the audit trail so a trim is reversible (for a user whose ledger is incomplete, the summary
// rows may be the only per-day history, and they all look like slack). unabsorbed > 0 means the
// target is below the ledger itself, which no summary edit should hide.
async function trimSummaryExcess(models, user, targetTotal, preferredDate, opts = {}) {
  const { DailySummary } = models;
  const uid = user._id || user.id;
  const isMongo = dbFactory.isMongoDB();
  const tx = opts.transaction ? { transaction: opts.transaction } : {};
  const rows = isMongo
    ? await DailySummary.find({ userId: uid })
    : await DailySummary.findAll({ where: { userId: uid }, ...tx });
  const summarySum = rows.reduce((s, r) => s + Number(r.dailyCount || 0), 0);
  let excess = summarySum - targetTotal;
  if (excess <= 0) return { removed: 0, unabsorbed: 0, changes: [] };

  const ledger = await ledgerByDate(models, uid, opts);
  const dateOf = (r) => moment(r.date).format('YYYY-MM-DD');
  const slack = (r) => Math.max(0, Number(r.dailyCount || 0) - (ledger.get(dateOf(r)) || 0));
  const ordered = rows
    .filter((r) => slack(r) > 0)
    .sort((a, b) => {
      const ap = dateOf(a) === preferredDate ? 1 : 0;
      const bp = dateOf(b) === preferredDate ? 1 : 0;
      return (bp - ap) || (slack(b) - slack(a));
    });

  let removed = 0;
  const changes = [];
  for (const r of ordered) {
    if (excess <= 0) break;
    const before = Number(r.dailyCount || 0);
    const take = Math.min(slack(r), excess);
    r.dailyCount = before - take;
    // Whatever non-ledger count remains in the row after the trim is, by definition, recovery
    // (the ledger holds every chanted event). Recompute the marker from that rather than from
    // its old value so an UNMARKED inflated row ends up correctly labelled too.
    r.recoveryCount = Math.max(0, (before - take) - (ledger.get(dateOf(r)) || 0));
    r.totalCount = Math.min(Number(r.totalCount || 0), targetTotal);
    await r.save(tx);
    changes.push({ date: dateOf(r), before, after: before - take });
    excess -= take;
    removed += take;
  }
  // Running-total snapshots on the untouched rows must not advertise a total that no longer exists.
  if (isMongo) {
    await DailySummary.updateMany({ userId: uid, totalCount: { $gt: targetTotal } }, { $set: { totalCount: targetTotal } });
  } else {
    await DailySummary.update({ totalCount: targetTotal }, { where: { userId: uid, totalCount: { [Op.gt]: targetTotal } }, ...tx });
  }
  return { removed, unabsorbed: excess, changes };
}

// Make SUM(DailySummary) == targetTotal in BOTH directions: a positive gap is backfilled into one
// recovery row, a negative gap is trimmed out of non-ledger rows.
// Returns { added, removed, unabsorbed, changes }.
async function alignSummaryToTotal(models, user, targetTotal, recoveryDate, opts = {}) {
  const date = resolveRecoveryDate(user, recoveryDate);
  const added = await backfillSummaryGap(models, user, targetTotal, date, opts);
  if (added > 0) return { added, removed: 0, unabsorbed: 0, changes: [{ date, added }] };
  const { removed, unabsorbed, changes } = await trimSummaryExcess(models, user, targetTotal, date, opts);
  return { added: 0, removed, unabsorbed, changes };
}

// Shared core of set-count and realign-summary. On SQL it runs in ONE transaction holding a row
// lock on the user (SELECT ... FOR UPDATE), and sync-events locks the same row, so a concurrent
// sync cannot interleave and silently undo the admin's total or leave the summaries aligned to a
// stale number. Returns { user, oldTotal, aligned, ledgerSum, warning }.
async function correctUserTotal(models, user, newTotal, recoveryDate) {
  const { User, Activity } = models;
  const isMongo = dbFactory.isMongoDB();

  const run = async (t) => {
    const opts = t ? { transaction: t } : {};
    let u = user;
    if (!isMongo) u = await User.findByPk(user.id, { ...opts, lock: t ? t.LOCK.UPDATE : undefined });
    if (!u) throw new Error('User not found');
    const oldTotal = Number(u.totalCount || 0);
    if (isMongo) { u.totalCount = newTotal; await u.save(); }
    else { await User.update({ totalCount: newTotal }, { where: { id: u.id }, ...opts }); }

    const aligned = await alignSummaryToTotal(models, u, newTotal, recoveryDate, opts);

    // Ledger sum for the caller's warning: a total set below the chanted ledger is not durable —
    // the next sync-events call raises it back to the ledger (monotonic guarantee).
    let ledgerSum = 0;
    if (isMongo) {
      const agg = await Activity.aggregate([
        { $match: { userId: u._id, activityType: 'COUNT_INCREMENT' } },
        { $group: { _id: null, total: { $sum: '$count' } } },
      ]);
      ledgerSum = (agg && agg[0] && agg[0].total) || 0;
    } else {
      ledgerSum = (await Activity.sum('count', { where: { userId: u.id, activityType: 'COUNT_INCREMENT' }, ...opts })) || 0;
    }
    return { oldTotal, aligned, ledgerSum };
  };

  const result = isMongo ? await run(null) : await dbFactory.getConnection().transaction(run);
  const fresh = isMongo ? await User.findById(user._id) : await User.findByPk(user.id);
  const warning = newTotal < result.ledgerSum
    ? `totalCount (${newTotal}) is below the chanted ledger (${result.ledgerSum}); the next sync will raise it back to the ledger`
    : null;
  return { ...result, user: fresh, warning };
}

// Get all users
router.get('/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User } = getModels();
    const { limit = 50, page = 1, search = '', appId } = req.query;
    const skip = (page - 1) * limit;

    let users;
    if (dbFactory.isMongoDB()) {
      // Hide soft-deleted users from the admin list (their data is kept, just not shown).
      const query = { ...(appId && { appId }), deletedAt: null };

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
      const where = { ...(appId && { appId }), deletedAt: null };

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
router.put('/users/:userId/status', authMiddleware, adminMiddleware, requireMinAdminAppVersion, async (req, res) => {
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
router.put('/users/:userId', authMiddleware, adminMiddleware, requireMinAdminAppVersion, async (req, res) => {
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

// Soft-delete a user (data-safe). We NEVER hard-delete the row or destroy their activity
// ledger / daily summaries. We set deletedAt = now, which HIDES them from admin lists and
// BLOCKS login, while keeping every row intact and fully recoverable (see /restore). The
// deletion is recorded in the audit trail (who/when/IP) as the deletion history.
router.delete('/users/:userId', authMiddleware, adminMiddleware, requireMinAdminAppVersion, async (req, res) => {
  try {
    const { User } = getModels();
    const { userId } = req.params;
    const now = new Date();

    let user;
    if (dbFactory.isMongoDB()) {
      user = await User.findById(userId);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      user = await User.findByIdAndUpdate(userId, { deletedAt: now }, { new: true });
    } else {
      user = await User.findByPk(userId);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      await User.update({ deletedAt: now }, { where: { id: userId } });
      user = await User.findByPk(userId);
    }

    await logAdminAction(req, 'DELETE_USER', {
      targetUserId: user._id || user.id, targetMobile: user.mobile,
      details: { name: user.name, totalCount: user.totalCount, deletedAt: now },
    });
    res.json({
      success: true,
      message: 'User deleted (hidden from lists). All data is preserved and recoverable.',
      user,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Restore a soft-deleted user (clear deletedAt) — undoes a delete, data was never lost.
router.put('/users/:userId/restore', authMiddleware, adminMiddleware, requireMinAdminAppVersion, async (req, res) => {
  try {
    const { User } = getModels();
    const { userId } = req.params;
    let user;
    if (dbFactory.isMongoDB()) {
      user = await User.findByIdAndUpdate(userId, { deletedAt: null }, { new: true });
    } else {
      await User.update({ deletedAt: null }, { where: { id: userId } });
      user = await User.findByPk(userId);
    }
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    await logAdminAction(req, 'RESTORE_USER', { targetUserId: user._id || user.id, targetMobile: user.mobile, details: { name: user.name } });
    res.json({ success: true, message: 'User restored.', user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// List soft-deleted users (the deletion view): who was deleted, their preserved count,
// and when. Data is intact — each can be restored.
router.get('/deleted-users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User } = getModels();
    const { appId } = req.query;
    let users;
    if (dbFactory.isMongoDB()) {
      users = await User.find({ ...(appId && { appId }), deletedAt: { $ne: null } }).sort({ deletedAt: -1 });
    } else {
      users = await User.findAll({ where: { ...(appId && { appId }), deletedAt: { [Op.ne]: null } }, order: [['deletedAt', 'DESC']] });
    }
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Restore every user's totalCount from the immutable activity ledger (never lowers it).
// One-shot repair tool to heal any account whose cached count drifted below its real
// history — e.g. after the old destructive bugs. Safe to run repeatedly.
router.post('/reconcile-counts', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const models = getModels();
    const { User, Activity, DailySummary } = models;
    const results = { checked: 0, restored: 0, summaryBackfilled: 0, summaryAboveTotal: [], details: [] };
    const isMongo = dbFactory.isMongoDB();

    const users = isMongo ? await User.find({}) : await User.findAll();
    for (const u of users) {
      results.checked += 1;
      const uid = u._id || u.id;
      // Floor 1: immutable activity ledger.
      let ledger = 0;
      if (isMongo) {
        const agg = await Activity.aggregate([
          { $match: { userId: u._id, activityType: 'COUNT_INCREMENT' } },
          { $group: { _id: null, total: { $sum: '$count' } } },
        ]);
        ledger = (agg && agg[0] && agg[0].total) || 0;
      } else {
        ledger = (await Activity.sum('count', { where: { userId: uid, activityType: 'COUNT_INCREMENT' } })) || 0;
      }
      // Daily-summary sum: NOT a floor. Summary rows can legitimately sit above the total when an
      // admin lowered a count via set-count, so trusting them here would re-inflate a corrected
      // total (e.g. 4.1L -> 11.6L). Surface such users instead; set-count re-aligns them.
      let summarySum = 0;
      if (isMongo) {
        const agg = await DailySummary.aggregate([{ $match: { userId: u._id } }, { $group: { _id: null, total: { $sum: '$dailyCount' } } }]);
        summarySum = (agg && agg[0] && agg[0].total) || 0;
      } else {
        summarySum = (await DailySummary.sum('dailyCount', { where: { userId: uid } })) || 0;
      }
      // Canonical = higher of the cached total and the immutable ledger (never lowers a count).
      const current = Number(u.totalCount || 0);
      const canonical = Math.max(current, ledger);
      if (summarySum > canonical) {
        // ledgerSum ~= totalCount => stale recovery row (realign-summary fixes it);
        // ledgerSum << summarySum  => the summary may be the only record of real counts — investigate first.
        results.summaryAboveTotal.push({ id: uid, mobile: u.mobile, totalCount: canonical, ledgerSum: ledger, summarySum, excess: summarySum - canonical });
      }

      let changed = false;
      if (canonical > current) {
        if (isMongo) { u.totalCount = canonical; await u.save(); }
        else { await User.update({ totalCount: canonical }, { where: { id: uid } }); }
        results.restored += 1;
        changed = true;
      }
      // Enforce SUM(DailySummary) == canonical so reports match.
      const backfilled = await backfillSummaryGap(models, u, canonical, moment(u.createdAt || new Date()).format('YYYY-MM-DD'));
      if (backfilled > 0) { results.summaryBackfilled += 1; changed = true; }
      if (changed) results.details.push({ id: uid, mobile: u.mobile, from: current, to: canonical, summaryGapAdded: backfilled });
    }

    await logAdminAction(req, 'RECONCILE_COUNTS', { details: { checked: results.checked, restored: results.restored, summaryBackfilled: results.summaryBackfilled, summaryAboveTotal: results.summaryAboveTotal.length } });
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

    // Enforce SUM(DailySummary) == newTotal in BOTH directions so reports/PDF and the app's
    // "Best day" match the corrected total (a lowered total trims stale recovery rows). Runs in
    // one transaction with a row lock; if anything throws, nothing is applied and we return 500.
    const r = await correctUserTotal(getModels(), user, newTotal, req.body.recoveryDate);

    await logAdminAction(req, 'SET_COUNT', {
      targetUserId: user._id || user.id, targetMobile: user.mobile,
      details: {
        from: r.oldTotal, to: newTotal, reason: req.body.reason || null,
        recoverySummaryAdded: r.aligned.added, summaryTrimmed: r.aligned.removed, summaryUnabsorbed: r.aligned.unabsorbed,
        summaryChanges: r.aligned.changes,
      },
    });
    res.json({
      success: true, user: r.user, from: r.oldTotal, to: newTotal,
      recoverySummaryAdded: r.aligned.added, summaryTrimmed: r.aligned.removed, summaryUnabsorbed: r.aligned.unabsorbed,
      summaryChanges: r.aligned.changes, ledgerSum: r.ledgerSum, warning: r.warning,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Re-align a user's DailySummary rows to their CURRENT total without changing the total. This is
// the repair for a drift-report / reconcile-counts "summaryAboveTotal" entry (a stale recovery row
// left behind by an earlier lowered total). The admin app cannot submit set-count with an unchanged
// value, so this endpoint exists for exactly that case. Audited as REALIGN_SUMMARY.
router.post('/users/:userId/realign-summary', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { User } = getModels();
    const { userId } = req.params;
    let user;
    if (dbFactory.isMongoDB()) user = await User.findById(userId);
    else user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const total = Number(user.totalCount || 0);
    const r = await correctUserTotal(getModels(), user, total, req.body && req.body.recoveryDate);

    await logAdminAction(req, 'REALIGN_SUMMARY', {
      targetUserId: user._id || user.id, targetMobile: user.mobile,
      details: {
        totalCount: total, reason: (req.body && req.body.reason) || null,
        recoverySummaryAdded: r.aligned.added, summaryTrimmed: r.aligned.removed, summaryUnabsorbed: r.aligned.unabsorbed,
        summaryChanges: r.aligned.changes,
      },
    });
    res.json({
      success: true, user: r.user, totalCount: total,
      recoverySummaryAdded: r.aligned.added, summaryTrimmed: r.aligned.removed, summaryUnabsorbed: r.aligned.unabsorbed,
      summaryChanges: r.aligned.changes, ledgerSum: r.ledgerSum, warning: r.warning,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Change the admin password (in-app). Verifies the current password (against the stored
// credential OR the env master), then stores the new one hashed. The env-var password
// (ADMIN_PASSWORD) always remains valid as a recovery master, so there is no lockout risk.
router.put('/change-password', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ success: false, message: 'New password must be different from the current password.' });
    }

    const { verifyAdminLogin, setAdminPassword } = require('../utils/adminCredential');
    const adminUsername = (req.user && req.user.username) || process.env.ADMIN_USERNAME || 'admin';
    const ok = await verifyAdminLogin(getModels(), dbFactory, adminUsername, currentPassword);
    if (!ok) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }

    await setAdminPassword(getModels(), dbFactory, newPassword);
    await logAdminAction(req, 'CHANGE_PASSWORD', { details: { changedBy: adminUsername } });
    res.json({ success: true, message: 'Admin password changed successfully.' });
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
    const { Activity, User } = getModels();
    const limit = parseInt(req.query.limit, 10) || 50;
    const page = parseInt(req.query.page, 10) || 1;
    const { type = '', userId = '', appId } = req.query;
    const skip = (page - 1) * limit;

    let activities, total;
    if (dbFactory.isMongoDB()) {
      const query = {};
      // Exclude the per-count COUNT_INCREMENT spam from the human feed unless explicitly
      // requested — those flood the list and belong in stats, not the activity log.
      if (type) query.activityType = type;
      else query.activityType = { $ne: 'COUNT_INCREMENT' };
      if (userId) query.userId = userId;
      if (appId) query.appId = appId;

      total = await Activity.countDocuments(query);
      activities = await Activity.find(query)
        .populate('userId', 'name email')
        .sort({ timestamp: -1 })
        .limit(limit)
        .skip(skip);
    } else {
      const where = {};
      if (type) where.activityType = type;
      else where.activityType = { [Op.ne]: 'COUNT_INCREMENT' };
      if (userId) where.userId = userId;
      if (appId) where.appId = appId;

      total = await Activity.count({ where });
      activities = await Activity.findAll({
        where,
        include: [{ model: User, attributes: ['name', 'email'] }],
        order: [['timestamp', 'DESC']],
        limit,
        offset: skip
      });
    }

    res.json({
      success: true,
      activities,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
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
      // Exclude soft-deleted users from all dashboard counts/top-lists.
      const userQuery = { ...(appId && { appId }), deletedAt: null };
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

      const allTimeUsers = await User.find({ ...(appId && { appId }), deletedAt: null }, 'totalCount name');
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
      const userWhere = { ...(appId && { appId }), deletedAt: null };
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
      // MongoDB aggregation to get unique apps with counts (excluding soft-deleted users)
      apps = await User.aggregate([
        { $match: { deletedAt: null } },
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
      // SQL query to get unique apps with counts (excluding soft-deleted users)
      const sequelize = dbFactory.getConnection();
      const results = await sequelize.query(
        'SELECT appId, COUNT(*) as userCount FROM users WHERE deletedAt IS NULL GROUP BY appId ORDER BY appId',
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
      const userMatch = { ...(appId && { appId }), deletedAt: null };
      const allUsers = userId
        ? await User.find({ _id: userId, ...(appId && { appId }), deletedAt: null })
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
      const userWhere = { ...(appId && { appId }), deletedAt: null };
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
      const userMatch = { ...(appId && { appId }), deletedAt: null };
      const allUsers = userId ? await User.find({ _id: userId, ...(appId && { appId }), deletedAt: null }) : await User.find(userMatch);
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
      const userWhere = { ...(appId && { appId }), deletedAt: null };
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

// Auth for the read-only drift report: a valid admin JWT, OR a static key (for unattended
// schedulers like cron-job.org that can't do a JWT login). The static path is enabled ONLY when
// DRIFT_REPORT_KEY is set in the env; the key is sent via the `X-Drift-Key` header or `?key=`.
// Constant-time compared. With no env key set, this falls back to admin-JWT only (secure default).
const driftAuth = (req, res, next) => {
  const secret = process.env.DRIFT_REPORT_KEY;
  const provided = req.headers['x-drift-key'] || req.query.key;
  if (secret && provided) {
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(secret));
    if (a.length === b.length && require('crypto').timingSafeEqual(a, b)) return next();
  }
  // Fall back to the standard admin JWT check.
  return authMiddleware(req, res, () => adminMiddleware(req, res, next));
};

// Track D — count-drift report (READ-ONLY). Compares each user's totalCount cache against the
// immutable COUNT_INCREMENT ledger and surfaces drift, so ops can health-check counts without
// shell/DB access (works on Render free tier). Point a free scheduler (e.g. cron-job.org) at this
// with the X-Drift-Key header and alert on `healthy:false`. Healing a below-ledger cache is handled
// by the existing POST /reconcile-counts (only ever raises). Optional query: ?appId=<id>.
router.get('/drift-report', driftAuth, async (req, res) => {
  try {
    if (dbFactory.isMongoDB()) {
      return res.status(501).json({ success: false, message: 'drift-report is available on the SQL backend only' });
    }
    const sequelize = dbFactory.getConnection();
    const appId = req.query.appId;
    const appClause = appId ? 'AND u.appId = :appId' : '';
    const repl = appId ? { appId } : {};
    const LEDGER = `LEFT JOIN (SELECT userId, SUM(count) AS ledgerSum FROM activities WHERE activityType='COUNT_INCREMENT' GROUP BY userId) l ON l.userId = u.id`;

    // 1) Summary counts.
    const [summary] = await sequelize.query(
      `SELECT COUNT(*) AS scanned,
              SUM(u.totalCount = COALESCE(l.ledgerSum,0)) AS inSync,
              SUM(u.totalCount > COALESCE(l.ledgerSum,0)) AS cacheAboveLedger,
              SUM(u.totalCount < COALESCE(l.ledgerSum,0)) AS criticalBelowLedger
         FROM users u ${LEDGER}
        WHERE u.deletedAt IS NULL ${appClause}`,
      { type: QueryTypes.SELECT, replacements: repl }
    );

    // 2) The critical rows — users whose shown total is BELOW their ledger (the "lost count" signal).
    const critical = await sequelize.query(
      `SELECT u.id, u.name, u.mobile, u.appId,
              CAST(u.totalCount AS SIGNED) AS totalCount,
              CAST(COALESCE(l.ledgerSum,0) AS SIGNED) AS ledgerSum,
              CAST(u.totalCount - COALESCE(l.ledgerSum,0) AS SIGNED) AS drift
         FROM users u ${LEDGER}
        WHERE u.deletedAt IS NULL AND u.totalCount < COALESCE(l.ledgerSum,0) ${appClause}
        ORDER BY drift ASC LIMIT 100`,
      { type: QueryTypes.SELECT, replacements: repl }
    );

    // 3) Idempotency invariant — no duplicate (userId, clientEventId). Guarded for DBs missing the column.
    let duplicateKeys = [];
    try {
      duplicateKeys = await sequelize.query(
        `SELECT userId, clientEventId, COUNT(*) AS c FROM activities
          WHERE clientEventId IS NOT NULL AND activityType='COUNT_INCREMENT'
          GROUP BY userId, clientEventId HAVING c > 1 LIMIT 100`,
        { type: QueryTypes.SELECT }
      );
    } catch (_) { /* clientEventId column absent — skip */ }

    // 4) Display-consistency invariant — SUM(DailySummary) must not exceed the user's total. When it
    //    does, the app shows a "Best day" larger than the Total (stale recovery row after a lowered
    //    total). Fix: POST /api/admin/users/:id/realign-summary. ledgerSum is included so a stale
    //    row (ledgerSum ~= totalCount) can be told apart from summary-only real history
    //    (ledgerSum << summarySum), which deserves a look before anything is trimmed.
    const summaryAboveTotal = await sequelize.query(
      `SELECT u.id, u.name, u.mobile, u.appId,
              CAST(u.totalCount AS SIGNED) AS totalCount,
              CAST(COALESCE(l.ledgerSum,0) AS SIGNED) AS ledgerSum,
              CAST(s.summarySum AS SIGNED) AS summarySum,
              CAST(s.bestDay AS SIGNED) AS bestDay,
              CAST(s.summarySum - u.totalCount AS SIGNED) AS excess
         FROM users u
         JOIN (SELECT userId, SUM(dailyCount) AS summarySum, MAX(dailyCount) AS bestDay
                 FROM dailysummaries GROUP BY userId) s ON s.userId = u.id
         ${LEDGER}
        WHERE u.deletedAt IS NULL AND s.summarySum > u.totalCount ${appClause}
        ORDER BY excess DESC LIMIT 100`,
      { type: QueryTypes.SELECT, replacements: repl }
    );

    const criticalBelowLedger = Number(summary.criticalBelowLedger) || 0;
    const healthy = criticalBelowLedger === 0 && duplicateKeys.length === 0 && summaryAboveTotal.length === 0;

    // Scheduler helper: with ?failUnhealthy=1, return HTTP 503 on drift so a plain uptime monitor
    // (e.g. cron-job.org) alerts on the failed status without needing response-body matching.
    const failUnhealthy = req.query.failUnhealthy === '1' || req.query.failUnhealthy === 'true' || req.query.alert === '1';
    res.status(failUnhealthy && !healthy ? 503 : 200).json({
      success: true,
      healthy,
      generatedAt: new Date().toISOString(),
      summary: {
        scanned: Number(summary.scanned) || 0,
        inSync: Number(summary.inSync) || 0,
        cacheAboveLedger: Number(summary.cacheAboveLedger) || 0,
        criticalBelowLedger,
        duplicateKeys: duplicateKeys.length,
        summaryAboveTotal: summaryAboveTotal.length,
      },
      critical,        // fix these via POST /api/admin/reconcile-counts (only raises to the ledger)
      duplicateKeys,
      summaryAboveTotal, // fix each via POST /api/admin/users/:id/realign-summary
    });
  } catch (error) {
    console.error('drift-report error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
