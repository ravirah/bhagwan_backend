if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const moment = require('moment');
const mongoose = require('mongoose');
const dbFactory = require('../config/database');
const { initModels, getModels } = require('../models/sql');

function getActiveDurationSeconds(firstCountAt, lastCountAt) {
  if (!firstCountAt || !lastCountAt) return 0;
  const start = moment(firstCountAt);
  const end = moment(lastCountAt);
  if (!start.isValid() || !end.isValid()) return 0;
  return Math.max(0, end.diff(start, 'seconds'));
}

function isConsecutiveDay(previousDate, currentDate) {
  if (!previousDate || !currentDate) return false;
  return moment(currentDate, 'YYYY-MM-DD').diff(moment(previousDate, 'YYYY-MM-DD'), 'days') === 1;
}

async function initDatabase() {
  const db = await dbFactory.connect();
  if (dbFactory.isSQL()) {
    await initModels(db.connection);
  } else {
    require('../models/mongodb');
  }
  return db;
}

async function backfillSQL() {
  const sequelize = dbFactory.getConnection();
  const { DailySummary } = getModels();

  const [rows] = await sequelize.query(`
    SELECT
      userId,
      COALESCE(appId, 'ram-bank') AS appId,
      DATE(timestamp) AS date,
      MIN(timestamp) AS firstCountAt,
      MAX(timestamp) AS lastCountAt,
      SUM(count) AS dailyCount
    FROM activities
    WHERE activityType = 'COUNT_INCREMENT'
    GROUP BY userId, COALESCE(appId, 'ram-bank'), DATE(timestamp)
    ORDER BY userId ASC, DATE(timestamp) ASC
  `);

  let currentUserId = null;
  let runningTotal = 0;
  let streak = 0;
  let previousDate = null;
  let updated = 0;
  let created = 0;

  for (const row of rows) {
    const date = moment(row.date).format('YYYY-MM-DD');
    const dailyCount = Number(row.dailyCount || 0);
    const duration = getActiveDurationSeconds(row.firstCountAt, row.lastCountAt);

    if (currentUserId !== row.userId) {
      currentUserId = row.userId;
      runningTotal = 0;
      streak = 0;
      previousDate = null;
    }

    runningTotal += dailyCount;
    streak = isConsecutiveDay(previousDate, date) ? streak + 1 : 1;

    const payload = {
      userId: row.userId,
      appId: row.appId || 'ram-bank',
      date,
      dailyCount,
      totalCount: runningTotal,
      streak,
      firstCountAt: row.firstCountAt,
      lastCountAt: row.lastCountAt,
      activeDurationSeconds: duration,
    };

    const existing = await DailySummary.findOne({ where: { userId: row.userId, date } });
    if (existing) {
      await existing.update(payload);
      updated += 1;
    } else {
      await DailySummary.create(payload);
      created += 1;
    }

    previousDate = date;
  }

  return { rows: rows.length, updated, created };
}

async function backfillMongo() {
  const { Activity, DailySummary } = require('../models/mongodb');

  const rows = await Activity.aggregate([
    { $match: { activityType: 'COUNT_INCREMENT' } },
    {
      $group: {
        _id: {
          userId: '$userId',
          date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
        },
        firstCountAt: { $min: '$timestamp' },
        lastCountAt: { $max: '$timestamp' },
        dailyCount: { $sum: '$count' },
      },
    },
    { $sort: { '_id.userId': 1, '_id.date': 1 } },
  ]);

  let currentUserId = null;
  let runningTotal = 0;
  let streak = 0;
  let previousDate = null;
  let updated = 0;
  let created = 0;

  for (const row of rows) {
    const userId = String(row._id.userId);
    const date = row._id.date;
    const dailyCount = Number(row.dailyCount || 0);
    const duration = getActiveDurationSeconds(row.firstCountAt, row.lastCountAt);

    if (currentUserId !== userId) {
      currentUserId = userId;
      runningTotal = 0;
      streak = 0;
      previousDate = null;
    }

    runningTotal += dailyCount;
    streak = isConsecutiveDay(previousDate, date) ? streak + 1 : 1;

    const payload = {
      userId: row._id.userId,
      date,
      dailyCount,
      totalCount: runningTotal,
      streak,
      firstCountAt: row.firstCountAt,
      lastCountAt: row.lastCountAt,
      activeDurationSeconds: duration,
    };

    const existing = await DailySummary.findOne({ userId: row._id.userId, date });
    if (existing) {
      await DailySummary.updateOne({ _id: existing._id }, { $set: payload });
      updated += 1;
    } else {
      await DailySummary.create(payload);
      created += 1;
    }

    previousDate = date;
  }

  return { rows: rows.length, updated, created };
}

async function closeDatabase() {
  try {
    if (dbFactory.isSQL()) {
      const sequelize = dbFactory.getConnection();
      if (sequelize && typeof sequelize.close === 'function') {
        await sequelize.close();
      }
      return;
    }

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  } catch (error) {
    console.error('Failed to close database connection:', error.message || error);
  }
}

async function main() {
  try {
    const db = await initDatabase();
    const result = dbFactory.isSQL() ? await backfillSQL() : await backfillMongo();

    console.log('Daily timing backfill complete');
    console.log(JSON.stringify({ dbType: db.type, ...result }, null, 2));
    await closeDatabase();
    process.exit(0);
  } catch (error) {
    console.error('Daily timing backfill failed');
    console.error(error);
    await closeDatabase();
    process.exit(1);
  }
}

main();
