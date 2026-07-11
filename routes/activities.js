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
    // Validate the delta. A missing field keeps the legacy default of 1 (backward compatible),
    // but any explicitly-provided value must be a positive integer — this stops a malformed
    // payload from silently truncating a batch to 1, or a negative value from lowering the total.
    const count = req.body.count === undefined ? 1 : Number(req.body.count);
    if (!Number.isInteger(count) || count <= 0) {
      return res.status(422).json({
        success: false,
        message: 'count must be a positive integer'
      });
    }
    const now = new Date();
    const today = moment(now).format('YYYY-MM-DD');

    let user;
    let summary;
    if (dbFactory.isMongoDB()) {
      user = await User.findByIdAndUpdate(
        req.user.userId,
        {
          $inc: { totalCount: count },
          lastActiveDate: now
        },
        { new: true }
      );
      await Activity.create({
        userId: req.user.userId,
        appId: user.appId,
        activityType: 'COUNT_INCREMENT',
        count,
        timestamp: now
      });
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
      // SQL: one ATOMIC transaction for totalCount + ledger + daily summary, so the three
      // stores can never drift apart (the root cause of inconsistent counts). If any write
      // fails, the whole increment rolls back and the mobile pending-queue retries.
      const sequelize = dbFactory.getConnection();
      const result = await sequelize.transaction(async (t) => {
        const u = await User.findByPk(req.user.userId, { transaction: t });
        await u.increment({ totalCount: count }, { transaction: t });
        u.lastActiveDate = now;
        await u.save({ fields: ['lastActiveDate'], transaction: t });
        await u.reload({ transaction: t });

        await Activity.create({
          userId: req.user.userId,
          appId: u.appId,
          activityType: 'COUNT_INCREMENT',
          count,
          timestamp: now
        }, { transaction: t });

        const [s, created] = await DailySummary.findOrCreate({
          where: { userId: req.user.userId, date: today },
          defaults: {
            userId: req.user.userId,
            appId: u.appId,
            date: today,
            dailyCount: count,
            totalCount: u.totalCount,
            firstCountAt: now,
            lastCountAt: now,
            activeDurationSeconds: 0
          },
          transaction: t
        });
        if (!created) {
          await s.increment({ dailyCount: count }, { transaction: t });
          const newFirstCountAt = s.firstCountAt && new Date(s.firstCountAt) < now ? s.firstCountAt : now;
          s.totalCount = u.totalCount;
          s.appId = u.appId;
          s.firstCountAt = newFirstCountAt;
          s.lastCountAt = now;
          s.activeDurationSeconds = getActiveDurationSeconds(newFirstCountAt, now);
          await s.save({ fields: ['totalCount', 'appId', 'firstCountAt', 'lastCountAt', 'activeDurationSeconds'], transaction: t });
          await s.reload({ transaction: t });
        }
        return { user: u, summary: s };
      });
      user = result.user;
      summary = result.summary;
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

// Idempotent batch sync of counted events (Phase 1 of the offline-first redesign).
// Each event carries a client-generated clientEventId (UUID); a retried batch is deduped by
// the UNIQUE(userId, clientEventId) index instead of being double-counted. The authoritative
// totalCount is RE-DERIVED from the immutable ledger on every call, so it self-corrects and can
// never drift below the ledger. Runs ALONGSIDE /add-count (which is unchanged), so old and new
// clients coexist during migration.
router.post('/sync-events', authMiddleware, async (req, res) => {
  try {
    const { User, Activity, DailySummary } = getModels();
    const events = Array.isArray(req.body.events) ? req.body.events : null;
    if (!events || events.length === 0) {
      return res.status(400).json({ success: false, message: 'events[] is required' });
    }
    if (events.length > 500) {
      return res.status(413).json({ success: false, message: 'too many events in one batch (max 500)' });
    }

    // Validate every event up front. Reject the WHOLE batch on any malformed entry so the client
    // keeps it queued and resends a corrected payload — never a silent partial apply.
    const clean = [];
    for (const e of events) {
      const delta = Number(e && e.delta);
      const clientEventId = e && e.clientEventId != null ? String(e.clientEventId).trim() : '';
      if (!clientEventId || clientEventId.length > 64 || !Number.isInteger(delta) || delta <= 0) {
        return res.status(422).json({
          success: false,
          message: 'each event needs a clientEventId and a positive integer delta',
          event: e
        });
      }
      const ts = e.ts ? new Date(e.ts) : new Date();
      clean.push({ clientEventId, delta, ts: isNaN(ts.getTime()) ? new Date() : ts });
    }

    // sync-events is implemented for the SQL backend (the production database). The legacy
    // /add-count endpoint remains available for the Mongo path, so nothing is lost there.
    if (dbFactory.isMongoDB()) {
      return res.status(501).json({
        success: false,
        message: 'sync-events is not supported on the MongoDB backend; use /add-count'
      });
    }

    const sequelize = dbFactory.getConnection();
    const { QueryTypes } = require('sequelize');

    const result = await sequelize.transaction(async (t) => {
      const u = await User.findByPk(req.user.userId, { transaction: t });
      if (!u) throw new Error('user not found');
      const currentTotal = Number(u.totalCount || 0);

      // 1) Insert ledger rows, ignoring any whose (userId, clientEventId) already exists.
      //    ignoreDuplicates => INSERT IGNORE: a previously-applied event is skipped, not doubled.
      //    We measure the ledger sum immediately before and after so newDelta counts ONLY the
      //    rows actually inserted this call (a duplicate batch inserts nothing => newDelta 0).
      const ledgerBefore = (await Activity.sum('count', {
        where: { userId: req.user.userId, activityType: 'COUNT_INCREMENT' },
        transaction: t
      })) || 0;
      const rows = clean.map((e) => ({
        userId: req.user.userId,
        appId: u.appId,
        activityType: 'COUNT_INCREMENT',
        count: e.delta,
        clientEventId: e.clientEventId,
        timestamp: e.ts
      }));
      await Activity.bulkCreate(rows, { transaction: t, ignoreDuplicates: true });
      const ledgerAfter = (await Activity.sum('count', {
        where: { userId: req.user.userId, activityType: 'COUNT_INCREMENT' },
        transaction: t
      })) || 0;
      const newDelta = ledgerAfter - ledgerBefore;

      // 2) MONOTONIC total. Credit ONLY the newly-applied delta on top of the current cache,
      //    and never fall below the ledger sum (self-heals an under-counted cache upward).
      //    This GUARANTEES totalCount can never DECREASE — critical for existing users whose
      //    cache legitimately exceeds their ledger (admin set-count / reconcile / legacy data);
      //    the previous "set = ledgerSum" would have collapsed those users' totals. Idempotent:
      //    a duplicate batch has newDelta 0 => newTotal = max(currentTotal, ledgerAfter) = currentTotal.
      const newTotal = Math.max(currentTotal + newDelta, ledgerAfter);
      await User.update(
        { totalCount: newTotal, lastActiveDate: new Date() },
        { where: { id: req.user.userId }, fields: ['totalCount', 'lastActiveDate'], transaction: t }
      );

      // 3) Update each affected day's summary, MERGING UPWARD (Math.max) so a day that carries a
      //    legitimate admin backfill is never lowered and reports can't regress. Idempotent under
      //    retries (max of equal values is a no-op).
      const dates = [...new Set(clean.map((e) => moment(e.ts).format('YYYY-MM-DD')))];
      for (const d of dates) {
        const [agg] = await sequelize.query(
          `SELECT COALESCE(SUM(count),0) AS sum, MIN(timestamp) AS first, MAX(timestamp) AS last
           FROM activities
           WHERE userId = :uid AND activityType = 'COUNT_INCREMENT' AND DATE(timestamp) = :d`,
          { replacements: { uid: req.user.userId, d }, transaction: t, type: QueryTypes.SELECT }
        );
        const dailyCount = Number(agg.sum) || 0;
        const first = agg.first ? new Date(agg.first) : null;
        const last = agg.last ? new Date(agg.last) : null;
        const [s, created] = await DailySummary.findOrCreate({
          where: { userId: req.user.userId, date: d },
          defaults: {
            userId: req.user.userId, appId: u.appId, date: d,
            dailyCount, totalCount: newTotal,
            firstCountAt: first, lastCountAt: last,
            activeDurationSeconds: getActiveDurationSeconds(first, last)
          },
          transaction: t
        });
        if (!created) {
          const mergedDaily = Math.max(Number(s.dailyCount || 0), dailyCount);
          const firstTimes = [s.firstCountAt, first].filter(Boolean).map((x) => new Date(x).getTime());
          const lastTimes = [s.lastCountAt, last].filter(Boolean).map((x) => new Date(x).getTime());
          const mergedFirst = firstTimes.length ? new Date(Math.min(...firstTimes)) : null;
          const mergedLast = lastTimes.length ? new Date(Math.max(...lastTimes)) : null;
          s.dailyCount = mergedDaily;
          s.totalCount = Math.max(Number(s.totalCount || 0), newTotal);
          s.appId = u.appId;
          s.firstCountAt = mergedFirst;
          s.lastCountAt = mergedLast;
          s.activeDurationSeconds = getActiveDurationSeconds(mergedFirst, mergedLast);
          await s.save({
            fields: ['dailyCount', 'totalCount', 'appId', 'firstCountAt', 'lastCountAt', 'activeDurationSeconds'],
            transaction: t
          });
        }
      }

      return { totalCount: newTotal };
    });

    // The client can mark ALL submitted events synced — each is now durably in the ledger,
    // whether inserted just now or already present from a prior attempt (at-least-once).
    res.json({
      success: true,
      accepted: clean.map((e) => e.clientEventId),
      totalCount: result.totalCount,
      message: 'Events synced'
    });
  } catch (error) {
    console.error('sync-events error:', error);
    res.status(500).json({ success: false, message: error.message });
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
