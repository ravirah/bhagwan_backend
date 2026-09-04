// End-to-end regression test for the DailySummary <-> totalCount alignment invariants:
//   set-count (up / down / below-ledger), realign-summary, reconcile-counts, drift-report,
//   and the sync-events row lock. Boots server.js against a throwaway SQLite database on a
//   spare port and drives it over HTTP exactly like the admin app does.
//
// Usage (from the repo root):   node scripts/test-summary-alignment.js
// Exit code 0 = all checks passed. No network, no .env, nothing touches a real database.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sqlite3 = require('sqlite3');

const PORT = Number(process.env.TEST_PORT || 3999);
const BASE = `http://localhost:${PORT}/api`;
const ROOT = path.resolve(__dirname, '..');
const DB = path.join(os.tmpdir(), `summary-alignment-${process.pid}.sqlite`);
try { fs.unlinkSync(DB); } catch (_) {}

const env = {
  ...process.env, DB_TYPE: 'sqlite', SQLITE_PATH: DB, PORT: String(PORT), NODE_ENV: 'test',
  JWT_SECRET: 'test-secret', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admintest', DB_SYNC_MODE: 'alter',
  MONGODB_URI: '', MYSQL_HOST: '',
};
const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', ...(o.headers || {}) } });
  const t = await r.text();
  try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, raw: t.slice(0, 200) }; }
};
const sql = (q, params = []) => new Promise((res, rej) => {
  const db = new sqlite3.Database(DB);
  db.all(q, params, (e, rows) => { db.close(); e ? rej(e) : res(rows); });
});
const run = (q, params = []) => new Promise((res, rej) => {
  const db = new sqlite3.Database(DB);
  db.run(q, params, function (e) { db.close(); e ? rej(e) : res(this.changes); });
});

let failures = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`);
  if (!cond) failures++;
};
const snapshot = async (uid) => {
  const rows = await sql('SELECT date, dailyCount, totalCount FROM dailysummaries WHERE userId=? ORDER BY date', [uid]);
  const [{ totalCount }] = await sql('SELECT totalCount FROM users WHERE id=?', [uid]);
  return { totalCount, summarySum: rows.reduce((s, r) => s + r.dailyCount, 0), rows };
};
const finish = () => {
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  server.kill();
  try { fs.unlinkSync(DB); } catch (_) {}
  if (failures) console.log('--- server log tail ---\n' + log.slice(-3000));
  process.exit(failures ? 1 : 0);
};

(async () => {
  for (let i = 0; i < 60; i++) { try { await fetch(BASE + '/auth/login', { method: 'POST' }); break; } catch { await sleep(500); } }
  const mobile = '9000000070';

  // Register (auto-create pending), approve directly in DB with a fixed signup date, then login.
  let r = await j('/auth/login', { method: 'POST', body: JSON.stringify({ name: 'Test Align', mobile, appId: 'ram-bank' }) });
  await run("UPDATE users SET status='approved', createdAt='2026-06-10 08:03:59' WHERE mobile=?", [mobile]);
  r = await j('/auth/login', { method: 'POST', body: JSON.stringify({ name: 'Test Align', mobile, appId: 'ram-bank' }) });
  const userToken = r.token;
  check('user login returns token', !!userToken, r);
  const [{ id: uid }] = await sql('SELECT id FROM users WHERE mobile=?', [mobile]);
  const U = { headers: { authorization: 'Bearer ' + userToken } };

  // Real chanting: 1000 in the ledger, today.
  await j('/activities/add-count', { method: 'POST', body: JSON.stringify({ count: 500 }), ...U });
  await j('/activities/add-count', { method: 'POST', body: JSON.stringify({ count: 500 }), ...U });
  let s = await snapshot(uid);
  check('ledger baseline: total 1000, summary 1000', s.totalCount === 1000 && s.summarySum === 1000, s);

  const a = await j('/auth/admin/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admintest' }) });
  check('admin login', !!a.token, a);
  const A = { headers: { authorization: 'Bearer ' + a.token } };
  const setCount = (total, extra = {}) => j(`/admin/users/${uid}/set-count`, { method: 'PUT', body: JSON.stringify({ totalCount: total, reason: 'test', ...extra }), ...A });

  // Replay prod user 70's history.
  r = await setCount(345678);
  s = await snapshot(uid);
  check('set-count UP 345678 backfills recovery row on signup date', r.recoverySummaryAdded === 344678 && s.summarySum === 345678 && s.rows[0].date === '2026-06-10' && s.rows[0].dailyCount === 344678, { r, s });

  r = await setCount(845678);
  s = await snapshot(uid);
  check('set-count UP 845678 grows recovery row', s.summarySum === 845678 && s.rows[0].dailyCount === 844678, s);

  r = await setCount(100000);
  s = await snapshot(uid);
  check('set-count DOWN 100000 trims recovery row, keeps ledger day', r.summaryTrimmed === 745678 && s.summarySum === 100000 && s.rows[0].dailyCount === 99000 && s.rows[1].dailyCount === 1000, { r, s });
  check('trim is recorded per row in the response', Array.isArray(r.summaryChanges) && r.summaryChanges.length === 1 && r.summaryChanges[0].date === '2026-06-10' && r.summaryChanges[0].before === 844678 && r.summaryChanges[0].after === 99000, r.summaryChanges);
  check('no row advertises a running total above the new total', s.rows.every((x) => x.totalCount <= 100000), s.rows);
  const audit = await sql("SELECT details FROM auditlogs WHERE action='SET_COUNT' ORDER BY id DESC LIMIT 1");
  const det = JSON.parse(audit[0].details);
  check('audit SET_COUNT carries summaryChanges', det.summaryTrimmed === 745678 && Array.isArray(det.summaryChanges) && det.summaryChanges[0].before === 844678, det);

  r = await setCount(500);
  s = await snapshot(uid);
  check('set-count BELOW ledger: trims to 0, reports unabsorbed 500 + warning, never cuts ledger day', r.summaryTrimmed === 99000 && r.summaryUnabsorbed === 500 && typeof r.warning === 'string' && r.ledgerSum === 1000 && s.rows[1].dailyCount === 1000 && s.rows[0].dailyCount === 0, { r, s });

  r = await setCount(414931);
  s = await snapshot(uid);
  check('set-count UP again re-backfills into the existing recovery row', s.summarySum === 414931 && s.rows.length === 2 && s.rows[0].dailyCount === 413931, s);

  // sync-events still works with the row lock and stays monotonic after an admin correction.
  r = await j('/activities/sync-events', { method: 'POST', body: JSON.stringify({ events: [{ clientEventId: 'evt-lock-1', delta: 69 }] }), ...U });
  s = await snapshot(uid);
  check('sync-events after set-count: locked read, total = 414931 + 69', r.success === true && r.totalCount === 415000 && s.totalCount === 415000 && s.summarySum === 415000, { r, s });
  r = await j('/activities/sync-events', { method: 'POST', body: JSON.stringify({ events: [{ clientEventId: 'evt-lock-1', delta: 69 }] }), ...U });
  s = await snapshot(uid);
  check('duplicate sync-events batch is idempotent', r.totalCount === 415000 && s.totalCount === 415000, { r, s });

  // Inflate a summary row behind the system's back (the prod corruption) and make sure reconcile does NOT trust it.
  await run("UPDATE dailysummaries SET dailyCount = dailyCount + 745694 WHERE userId=? AND date='2026-06-10'", [uid]);
  r = await j('/admin/reconcile-counts', { method: 'POST', ...A });
  s = await snapshot(uid);
  const flagged = (r.summaryAboveTotal || []).find((x) => x.id === uid);
  check('reconcile does NOT raise total to the inflated summary sum', s.totalCount === 415000, s.totalCount);
  check('reconcile reports the user under summaryAboveTotal with ledgerSum', !!flagged && flagged.excess === 745694 && flagged.ledgerSum === 1069, flagged);

  const d1 = await j('/admin/drift-report', A);
  const drift = (d1.summaryAboveTotal || []).find((x) => x.id === uid);
  check('drift-report lists the user (with ledgerSum) and is unhealthy', d1.healthy === false && d1.summary.summaryAboveTotal === 1 && !!drift && drift.excess === 745694 && drift.ledgerSum === 1069, { summary: d1.summary, drift });

  // Repair path an admin uses from the drift report: realign-summary (total unchanged).
  r = await j(`/admin/users/${uid}/realign-summary`, { method: 'POST', body: JSON.stringify({ reason: 'test realign' }), ...A });
  s = await snapshot(uid);
  check('realign-summary trims the inflated row back without touching the total', r.success === true && r.totalCount === 415000 && r.summaryTrimmed === 745694 && s.totalCount === 415000 && s.summarySum === 415000 && s.rows[0].dailyCount === 413931, { r, s });
  const realignAudit = await sql("SELECT details FROM auditlogs WHERE action='REALIGN_SUMMARY' ORDER BY id DESC LIMIT 1");
  check('realign-summary is audited with per-row changes', realignAudit.length === 1 && JSON.parse(realignAudit[0].details).summaryChanges[0].before === 413931 + 745694, realignAudit);

  const d2 = await j('/admin/drift-report', A);
  check('drift-report healthy again', d2.healthy === true && d2.summary.summaryAboveTotal === 0, d2.summary);

  r = await j(`/admin/users/${uid}/realign-summary`, { method: 'POST', body: JSON.stringify({}), ...A });
  check('realign-summary on an aligned user is a no-op', r.success === true && r.summaryTrimmed === 0 && r.recoverySummaryAdded === 0, r);

  // Daily summary the app reads: best <= total on the server side now.
  const ds = await j('/activities/daily-summary?days=30', U);
  const best = Math.max(...(ds.summaries || []).map((x) => x.dailyCount));
  check('user daily-summary best day <= total', best <= s.totalCount, { best, total: s.totalCount });

  finish();
})().catch((e) => { console.error('ERR', e); failures++; finish(); });
