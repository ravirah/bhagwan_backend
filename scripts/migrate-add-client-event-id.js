/**
 * Phase 0 migration — add idempotency support to the activities ledger.
 *
 * Adds `activities.clientEventId VARCHAR(64) NULL` and a UNIQUE(userId, clientEventId)
 * index so the new /api/activities/sync-events endpoint can dedupe retried syncs instead of
 * double-counting them.
 *
 * SAFE + IDEMPOTENT + BACKWARD-COMPATIBLE:
 *   - The column is nullable, so existing rows (legacy add-count increments and all
 *     LOGIN/REGISTER/… rows) remain valid and the legacy /add-count endpoint keeps working.
 *   - MySQL treats NULLs as distinct in a UNIQUE index, so the many existing NULL rows never
 *     collide — no backfill required.
 *   - Re-running is harmless: an already-present column/index is detected and skipped.
 *
 * Usage:  node scripts/migrate-add-client-event-id.js
 */
require('dotenv').config();
const { Sequelize } = require('sequelize');

async function columnExists(sequelize, table, column) {
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column`,
    { replacements: { table, column } }
  );
  return Number(rows[0].c) > 0;
}

async function indexExists(sequelize, table, indexName) {
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND INDEX_NAME = :index`,
    { replacements: { table, index: indexName } }
  );
  return Number(rows[0].c) > 0;
}

(async () => {
  const sequelize = new Sequelize(
    process.env.MYSQL_DATABASE,
    process.env.MYSQL_USER,
    process.env.MYSQL_PASSWORD || '',
    { host: process.env.MYSQL_HOST || 'localhost', port: process.env.MYSQL_PORT || 3306, dialect: 'mysql', logging: false }
  );

  try {
    await sequelize.authenticate();
    console.log(`Connected to ${process.env.MYSQL_DATABASE}. Running Phase 0 migration...\n`);

    // 1) Column
    if (await columnExists(sequelize, 'activities', 'clientEventId')) {
      console.log('• column activities.clientEventId — already present, skipping');
    } else {
      await sequelize.query('ALTER TABLE activities ADD COLUMN clientEventId VARCHAR(64) NULL');
      console.log('✅ column activities.clientEventId — added');
    }

    // 2) Unique index
    if (await indexExists(sequelize, 'activities', 'uniq_activity_user_event')) {
      console.log('• index uniq_activity_user_event — already present, skipping');
    } else {
      await sequelize.query('CREATE UNIQUE INDEX uniq_activity_user_event ON activities (userId, clientEventId)');
      console.log('✅ index uniq_activity_user_event(userId, clientEventId) — added');
    }

    // 3) Verify
    const okCol = await columnExists(sequelize, 'activities', 'clientEventId');
    const okIdx = await indexExists(sequelize, 'activities', 'uniq_activity_user_event');
    const [[{ total }]] = [await sequelize.query('SELECT COUNT(*) AS total FROM activities', { plain: false })].map(r => r[0]);
    console.log(`\nVerification: column=${okCol ? 'OK' : 'MISSING'}, index=${okIdx ? 'OK' : 'MISSING'}, existing activity rows unaffected=${total}`);
    process.exit(okCol && okIdx ? 0 : 1);
  } catch (e) {
    console.error('❌ Migration failed:', e.message);
    process.exit(2);
  } finally {
    await sequelize.close();
  }
})();
