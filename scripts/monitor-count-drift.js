/**
 * Track D — counter drift monitor (early-warning net).
 *
 * The `activities` table is the immutable ledger of every counted राम; `users.totalCount` is a
 * derived cache. This job compares the two per user and surfaces drift:
 *
 *   • CRITICAL  totalCount < ledgerSum  → the user's shown total is BELOW what they actually
 *               chanted (per the ledger). This is the exact "lost count" symptom — alert on it.
 *   • info      totalCount > ledgerSum  → cache above ledger. Expected & legitimate for users
 *               adjusted via admin set-count / reconcile / legacy data; reported, not alerted
 *               (unless it exceeds DRIFT_POSITIVE_THRESHOLD).
 *   • It also verifies the idempotency invariant: no duplicate (userId, clientEventId) rows.
 *
 * Exit code: 1 if any CRITICAL drift or duplicate keys are found (so cron/alerting can trip), else 0.
 *
 * Usage:
 *   node scripts/monitor-count-drift.js            # report only
 *   node scripts/monitor-count-drift.js --fix      # ALSO heal cache-below-ledger (raise to ledger; only-raises, safe)
 *   node scripts/monitor-count-drift.js --json     # machine-readable output
 *
 * Env (optional):
 *   DRIFT_ALERT_WEBHOOK        # if set, POSTs a JSON summary here when CRITICAL drift is found (Slack/Discord/etc.)
 *   DRIFT_POSITIVE_THRESHOLD   # if set (>0), a positive gap >= this also counts as an alert
 *
 * Schedule (examples):
 *   • cron:   0 2 * * *  cd /path/bhagwan-backend && node scripts/monitor-count-drift.js >> logs/drift.log 2>&1
 *   • Render: a Cron Job running `node scripts/monitor-count-drift.js` with the prod DB env vars.
 */
require('dotenv').config();
const { Sequelize, QueryTypes } = require('sequelize');

const FIX = process.argv.includes('--fix');
const JSON_OUT = process.argv.includes('--json');
const WEBHOOK = process.env.DRIFT_ALERT_WEBHOOK || '';
const POS_THRESHOLD = Number(process.env.DRIFT_POSITIVE_THRESHOLD || 0);

function log(...a) { if (!JSON_OUT) console.log(...a); }

(async () => {
  const sequelize = new Sequelize(
    process.env.MYSQL_DATABASE,
    process.env.MYSQL_USER,
    process.env.MYSQL_PASSWORD || '',
    { host: process.env.MYSQL_HOST || 'localhost', port: process.env.MYSQL_PORT || 3306, dialect: 'mysql', logging: false }
  );

  try {
    await sequelize.authenticate();

    // 1) Per-user: cache (totalCount) vs immutable ledger sum.
    const rows = await sequelize.query(
      `SELECT u.id, u.name, u.mobile, u.appId,
              CAST(u.totalCount AS SIGNED) AS totalCount,
              CAST(COALESCE(l.ledgerSum, 0) AS SIGNED) AS ledgerSum
         FROM users u
         LEFT JOIN (
           SELECT userId, SUM(count) AS ledgerSum
             FROM activities
            WHERE activityType = 'COUNT_INCREMENT'
            GROUP BY userId
         ) l ON l.userId = u.id
        WHERE u.deletedAt IS NULL`,
      { type: QueryTypes.SELECT }
    );

    const below = [];   // totalCount < ledgerSum  (CRITICAL)
    const above = [];    // totalCount > ledgerSum  (info)
    for (const r of rows) {
      const drift = Number(r.totalCount) - Number(r.ledgerSum);
      if (drift < 0) below.push({ ...r, drift });
      else if (drift > 0) above.push({ ...r, drift });
    }
    below.sort((a, b) => a.drift - b.drift);          // most-negative first
    above.sort((a, b) => b.drift - a.drift);          // largest gap first

    // 2) Idempotency invariant: no duplicate (userId, clientEventId). Guarded so the monitor
    //    still produces the core drift report even on a DB where the Phase 0 migration (the
    //    clientEventId column) has not been applied yet.
    let dups = [];
    let dupCheckSkipped = false;
    try {
      dups = await sequelize.query(
        `SELECT userId, clientEventId, COUNT(*) AS c
           FROM activities
          WHERE clientEventId IS NOT NULL AND activityType = 'COUNT_INCREMENT'
          GROUP BY userId, clientEventId
         HAVING c > 1`,
        { type: QueryTypes.SELECT }
      );
    } catch (e) {
      if (/clientEventId|unknown column/i.test(e.message || '')) dupCheckSkipped = true;
      else throw e;
    }

    const posAlert = POS_THRESHOLD > 0 ? above.filter(a => a.drift >= POS_THRESHOLD) : [];
    const critical = below.length > 0 || dups.length > 0 || posAlert.length > 0;

    // ---- Report ----
    const stamp = new Date().toISOString();
    log(`\n🩺 Count drift report — ${stamp}`);
    log(`   users scanned: ${rows.length}`);
    log(`   ✅ in sync (cache == ledger): ${rows.length - below.length - above.length}`);
    log(`   🟠 cache above ledger (info, usually admin/legacy): ${above.length}`);
    log(`   🔴 cache BELOW ledger (CRITICAL — shown total < actual): ${below.length}`);
    log(`   🔁 duplicate idempotency keys: ${dupCheckSkipped ? 'skipped (clientEventId column not present — run the Phase 0 migration)' : dups.length}`);

    if (below.length) {
      log('\n   CRITICAL — totalCount below ledger (potential lost display count):');
      for (const r of below.slice(0, 50)) {
        log(`     • [${r.appId}] ${r.name || '-'} (${r.mobile || r.id}): shown ${r.totalCount} < ledger ${r.ledgerSum}  (drift ${r.drift})`);
      }
      if (below.length > 50) log(`     …and ${below.length - 50} more`);
    }
    if (dups.length) {
      log('\n   DUPLICATE idempotency keys (should be impossible with the unique index):');
      for (const d of dups.slice(0, 20)) log(`     • userId ${d.userId} clientEventId ${d.clientEventId} ×${d.c}`);
    }
    if (above.length) {
      const totalGap = above.reduce((s, a) => s + a.drift, 0);
      log(`\n   Info — ${above.length} users have cache above ledger (total gap ${totalGap}); top 5:`);
      for (const r of above.slice(0, 5)) log(`     • ${r.name || '-'} (${r.mobile || r.id}): shown ${r.totalCount} > ledger ${r.ledgerSum}  (+${r.drift})`);
    }

    // ---- Optional self-heal (only ever RAISES the cache to the ledger) ----
    if (FIX && below.length) {
      for (const r of below) {
        await sequelize.query('UPDATE users SET totalCount = ? WHERE id = ?', { replacements: [r.ledgerSum, r.id] });
      }
      log(`\n   🛟 --fix: healed ${below.length} user(s) by raising totalCount to their ledger sum.`);
    }

    // ---- Optional webhook alert ----
    if (WEBHOOK && critical) {
      const summary = {
        text: `⚠️ Ram counter drift alert (${stamp}): ${below.length} users below ledger, ${dups.length} duplicate keys`
              + (posAlert.length ? `, ${posAlert.length} large positive gaps` : ''),
        criticalBelowLedger: below.slice(0, 20),
        duplicateKeys: dups.slice(0, 20),
      };
      try {
        await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary) });
        log('\n   📣 alert posted to DRIFT_ALERT_WEBHOOK');
      } catch (e) {
        log(`\n   (webhook post failed: ${e.message})`);
      }
    }

    if (JSON_OUT) {
      console.log(JSON.stringify({
        stamp, scanned: rows.length, inSync: rows.length - below.length - above.length,
        criticalBelowLedger: below, cacheAboveLedger: above.length, duplicateKeys: dups, healed: FIX ? below.length : 0,
      }, null, 2));
    }

    log(critical ? '\n❌ Drift detected — see above.' : '\n✅ No critical drift. Counts are healthy.');
    process.exit(critical && !FIX ? 1 : 0);   // after --fix, criticals are resolved → exit 0
  } catch (e) {
    console.error('❌ drift monitor failed:', e.message);
    process.exit(2);
  } finally {
    await sequelize.close();
  }
})();
