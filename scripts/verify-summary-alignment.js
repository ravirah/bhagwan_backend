/**
 * Post-deploy verification — summary/total alignment (drift-report over HTTP).
 *
 * Runs against the DEPLOYED backend (no DB access needed) and answers three questions:
 *
 *   1. Is the NEW drift-report build live?  The new build adds `summary.summaryAboveTotal` and the
 *      `summaryAboveTotal[]` list (SUM(DailySummary) > users.totalCount — the "Best day > Total" bug).
 *      The old build lacks the field, so its presence is the deploy fingerprint.
 *   2. Is the data healthy?  `healthy:true` ⇔ no cache-below-ledger users, no duplicate idempotency
 *      keys, and no summaryAboveTotal rows.
 *   3. (optional) For specific users, does totalCount line up with ledgerSum / summaryRows?
 *
 * Exit code: 0 when healthy AND the new build is deployed; 1 when either check fails;
 *            2 on a usage/network/auth error (the check itself could not run).
 *
 * Usage:
 *   DRIFT_REPORT_KEY=... node scripts/verify-summary-alignment.js
 *   ADMIN_USERNAME=... ADMIN_PASSWORD=... node scripts/verify-summary-alignment.js
 *   node scripts/verify-summary-alignment.js --json        # machine-readable output
 *
 * Env:
 *   API_BASE           # default https://bhagwan-backend-u0n9.onrender.com/api
 *   DRIFT_REPORT_KEY   # static key → sent as X-Drift-Key (drift-report only)
 *   ADMIN_USERNAME     # + ADMIN_PASSWORD → POST /auth/admin/login → Bearer JWT (all endpoints)
 *   ADMIN_PASSWORD
 *   CHECK_MOBILES      # optional, comma-separated → GET /admin/diagnose-user?mobile= for each.
 *                      # diagnose-user accepts admin JWT ONLY, so this needs ADMIN_USERNAME/PASSWORD.
 *   REQUEST_TIMEOUT_MS # default 90000 (Render free tier can cold-start for ~60s)
 *
 * Secrets are read from the process env only — this script deliberately does NOT load .env files.
 */
const JSON_OUT = process.argv.includes('--json');
const API_BASE = (process.env.API_BASE || 'https://bhagwan-backend-u0n9.onrender.com/api').replace(/\/+$/, '');
const DRIFT_KEY = process.env.DRIFT_REPORT_KEY || '';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const CHECK_MOBILES = (process.env.CHECK_MOBILES || '').split(',').map(s => s.trim()).filter(Boolean);
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 90000);

const haveKey = Boolean(DRIFT_KEY);
const haveCreds = Boolean(ADMIN_USERNAME && ADMIN_PASSWORD);

function log(...a) { if (!JSON_OUT) console.log(...a); }

function usage() {
  console.error(`
Usage: provide ONE of the following in the environment (never hardcoded, never read from .env):

  DRIFT_REPORT_KEY=<key>                          node scripts/verify-summary-alignment.js
  ADMIN_USERNAME=<user> ADMIN_PASSWORD=<pass>     node scripts/verify-summary-alignment.js

Optional: API_BASE=<url>/api   CHECK_MOBILES=9876543210,9123456789 (requires ADMIN_USERNAME/PASSWORD)   --json
`);
}

if (typeof fetch !== 'function') {
  console.error('❌ This script needs Node 18+ (global fetch). Current:', process.version);
  process.exit(2);
}

/** fetch + timeout + JSON parse. Returns { status, body }; throws on network failure / non-JSON. */
async function request(path, { method = 'GET', headers = {}, body } = {}) {
  const url = `${API_BASE}${path}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; }
    catch (_) { throw new Error(`${method} ${path} → HTTP ${res.status}, non-JSON body: ${text.slice(0, 200)}`); }
    return { status: res.status, body: json };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${method} ${path} timed out after ${TIMEOUT_MS} ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

let cachedToken = null;
async function getAdminToken() {
  if (cachedToken) return cachedToken;
  if (!haveCreds) return null;
  const { status, body } = await request('/auth/admin/login', {
    method: 'POST',
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  if (status !== 200 || !body.token) {
    throw new Error(`admin login failed (HTTP ${status}): ${body.message || 'no token in response'}`);
  }
  cachedToken = body.token;
  return cachedToken;
}

/** Auth headers for drift-report: static key preferred (matches the cron-job.org monitor), else JWT. */
async function driftAuthHeaders() {
  if (haveKey) return { 'X-Drift-Key': DRIFT_KEY };
  return { Authorization: `Bearer ${await getAdminToken()}` };
}

const n = v => (v === null || v === undefined ? '-' : Number(v));

(async () => {
  if (!haveKey && !haveCreds) {
    usage();
    process.exit(2);
  }

  const stamp = new Date().toISOString();
  const result = {
    stamp, apiBase: API_BASE, newBuildDeployed: false, healthy: false,
    summary: null, critical: [], duplicateKeys: [], summaryAboveTotal: [], diagnose: [],
  };

  try {
    log(`\n🔎 Post-deploy verification — ${stamp}`);
    log(`   API: ${API_BASE}`);
    log(`   auth: ${haveKey ? 'X-Drift-Key' : 'admin JWT (login)'}${haveKey && haveCreds ? ' + admin JWT available for diagnose-user' : ''}`);

    // ---- 1) drift-report ----
    const { status, body } = await request('/admin/drift-report', { headers: await driftAuthHeaders() });
    if (status === 401 || status === 403) {
      throw new Error(`drift-report rejected the credentials (HTTP ${status}): ${body.message || ''}`.trim());
    }
    if (status === 501) {
      throw new Error(`drift-report unavailable on this backend (HTTP 501): ${body.message || ''}`.trim());
    }
    if (status !== 200 || body.success !== true) {
      throw new Error(`drift-report failed (HTTP ${status}): ${body.message || JSON.stringify(body).slice(0, 200)}`);
    }

    const summary = body.summary || {};
    const critical = Array.isArray(body.critical) ? body.critical : [];
    const duplicateKeys = Array.isArray(body.duplicateKeys) ? body.duplicateKeys : [];
    const summaryAboveTotal = Array.isArray(body.summaryAboveTotal) ? body.summaryAboveTotal : [];

    // Deploy fingerprint: the old build has neither summary.summaryAboveTotal nor the list.
    const newBuild = Object.prototype.hasOwnProperty.call(summary, 'summaryAboveTotal') && Array.isArray(body.summaryAboveTotal);
    const healthy = body.healthy === true;

    Object.assign(result, { newBuildDeployed: newBuild, healthy, summary, critical, duplicateKeys, summaryAboveTotal, generatedAt: body.generatedAt });

    log(`\n🚀 new drift-report deployed: ${newBuild ? 'yes' : 'NO — summary.summaryAboveTotal missing (old build still serving; wait for the Render deploy to finish)'}`);
    log(`\n🩺 Drift report (server generatedAt ${body.generatedAt || '-'})`);
    log(`   users scanned: ${n(summary.scanned)}`);
    log(`   ✅ in sync (cache == ledger): ${n(summary.inSync)}`);
    log(`   🟠 cache above ledger (info, usually admin/legacy): ${n(summary.cacheAboveLedger)}`);
    log(`   🔴 cache BELOW ledger (CRITICAL — shown total < actual): ${n(summary.criticalBelowLedger)}`);
    log(`   🔁 duplicate idempotency keys: ${n(summary.duplicateKeys)}`);
    log(`   📈 summary above total (Best day > Total): ${newBuild ? n(summary.summaryAboveTotal) : 'n/a (old build)'}`);
    log(`   healthy: ${healthy}`);

    if (critical.length) {
      log('\n   CRITICAL — totalCount below ledger (fix: POST /api/admin/reconcile-counts — only raises):');
      for (const r of critical) {
        log(`     • id ${r.id} [${r.appId || '-'}] ${r.name || '-'} (${r.mobile || '-'}): totalCount ${n(r.totalCount)} < ledgerSum ${n(r.ledgerSum)}  (drift ${n(r.drift)})`);
      }
    }
    if (duplicateKeys.length) {
      log('\n   DUPLICATE idempotency keys (should be impossible with the unique index):');
      for (const d of duplicateKeys) log(`     • userId ${d.userId} clientEventId ${d.clientEventId} ×${d.c}`);
    }
    if (summaryAboveTotal.length) {
      log('\n   SUMMARY ABOVE TOTAL — fix each via PUT /api/admin/users/:id/set-count with the SAME totalCount:');
      for (const r of summaryAboveTotal) {
        log(`     • id ${r.id} [${r.appId || '-'}] ${r.name || '-'} (${r.mobile || '-'}): totalCount ${n(r.totalCount)}, summarySum ${n(r.summarySum)}, bestDay ${n(r.bestDay)}, excess +${n(r.excess)}`);
      }
    } else if (newBuild) {
      log("\n   ✅ summaryAboveTotal: none — every user's SUM(DailySummary) ≤ totalCount.");
    }

    // ---- 2) optional per-user diagnose ----
    if (CHECK_MOBILES.length) {
      log(`\n👤 diagnose-user for ${CHECK_MOBILES.length} mobile(s)`);
      if (!haveCreds) {
        log('   ⚠️  skipped — diagnose-user accepts an admin JWT only; set ADMIN_USERNAME + ADMIN_PASSWORD to enable.');
        result.diagnoseSkipped = 'no admin credentials';
      } else {
        const auth = { Authorization: `Bearer ${await getAdminToken()}` };
        for (const mobile of CHECK_MOBILES) {
          try {
            const r = await request(`/admin/diagnose-user?mobile=${encodeURIComponent(mobile)}`, { headers: auth });
            if (r.status !== 200 || r.body.success !== true) {
              log(`   • ${mobile}: ❌ HTTP ${r.status} ${r.body.message || ''}`.trim());
              result.diagnose.push({ mobile, error: `HTTP ${r.status} ${r.body.message || ''}`.trim() });
              continue;
            }
            const users = Array.isArray(r.body.matchingUsers) ? r.body.matchingUsers : [];
            result.diagnose.push({ mobile, matchingUsers: users, interpretation: r.body.interpretation });
            if (!users.length) { log(`   • ${mobile}: no matching users`); continue; }
            for (const u of users) {
              const flag = Number(u.totalCount) < Number(u.ledgerSum) ? '🔴' : '✅';
              log(`   ${flag} ${mobile} → id ${u.id} ${u.name || '-'} [${u.appId || '-'}]: totalCount ${n(u.totalCount)} | ledgerSum ${n(u.ledgerSum)} | summaryRows ${n(u.summaryRows)} | activityRows ${n(u.activityRows)}`);
            }
            if (users.length > 1) log(`     ⚠️  ${users.length} rows match "${mobile}" — ${r.body.interpretation || ''}`);
          } catch (e) {
            log(`   • ${mobile}: ❌ ${e.message}`);
            result.diagnose.push({ mobile, error: e.message });
          }
        }
      }
    }

    // ---- 3) verdict ----
    const pass = healthy && newBuild;
    result.pass = pass;
    if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
    if (pass) log('\n✅ PASS — new build deployed and drift-report is healthy.');
    else log(`\n❌ FAIL — ${[!newBuild && 'old build still serving', !healthy && 'drift-report reports healthy:false'].filter(Boolean).join('; ')}.`);
    process.exit(pass ? 0 : 1);
  } catch (e) {
    if (JSON_OUT) console.log(JSON.stringify({ ...result, error: e.message }, null, 2));
    console.error('❌ verification could not run:', e.message);
    process.exit(2);
  }
})();
