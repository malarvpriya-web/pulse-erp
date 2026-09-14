/**
 * sql-failure-probe.mjs — find SQL that fails at RUNTIME and is swallowed.
 *
 * `check-sql-references.mjs` validates identifiers statically, and its own
 * summary states the limit: SELECT-side unqualified columns are not checked.
 * That blind spot cannot see `SELECT name FROM inventory_items` (the column is
 * `item_name`), `GROUP BY band` binding to an input column instead of the output
 * alias, `AND company_id=1` pasted where a `WHERE` was needed, a bound-but-
 * unreferenced `$1`, or `integer = uuid`. Every one of those throws only when
 * Postgres runs the statement — and every analytics caller wraps its query in
 * `.catch(() => [])`, so the failure reaches the user as "no data".
 *
 * This probe boots the real server with `pg.Pool.prototype.query` wrapped, calls
 * every Analytics & AI endpoint, and reports which SQL rejected and where the
 * result was swallowed. It is the executable complement to the static gate.
 *
 *   node scripts/audit/sql-failure-probe.mjs            # boot + probe + report
 *   node scripts/audit/sql-failure-probe.mjs --port=5099
 *
 * Exit code 1 when any query failed, so it can be wired as a CI gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = (process.argv.find(a => a.startsWith('--port=')) || '--port=5099').split('=')[1];
const LOG = path.join(BACKEND, '.sql-failure-probe.log');

const BOOT = path.join(BACKEND, 'scripts/audit/sql-failure-probe.boot.mjs');

const ROUTE_FILES = [
  ['/ai',                        'src/modules/intelligence/ai.routes.js'],
  ['/ai',                        'src/modules/analytics/aiPayroll.routes.js'],
  ['/intelligence',              'src/modules/intelligence/intelligence.routes.js'],
  ['/ceo-intelligence',          'src/modules/intelligence/ceo-intelligence.routes.js'],
  ['/analytics',                 'src/analytics/routes/analytics.routes.js'],
  ['/analytics/pq',              'src/analytics/routes/powerQuality.routes.js'],
  ['/analytics/manufacturing',   'src/analytics/routes/manufacturing.routes.js'],
  ['/dashboard',                 'src/modules/dashboard/dashboard.routes.js'],
  ['/user-dashboard',            'src/modules/analytics/user-dashboard.routes.js'],
  ['/system-health',             'src/modules/admin/systemHealth.routes.js'],
];

function discoverGets() {
  const out = [];
  for (const [prefix, rel] of ROUTE_FILES) {
    const src = fs.readFileSync(path.join(BACKEND, rel), 'utf8');
    for (const m of src.matchAll(/router\.get\(\s*["'`]([^"'`]*)["'`]/g)) {
      const p = m[1] === '/' ? '' : m[1];
      // sub-routers are mounted separately above; don't probe them twice
      if (prefix === '/analytics' && (p.startsWith('/pq') || p.startsWith('/manufacturing'))) continue;
      out.push((prefix + p).replace(/:(\w+)/g, (s, n) => (n.toLowerCase().includes('id') ? '1' : 'x')));
    }
  }
  return [...new Set(out)];
}

const mintToken = () => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [path.join(BACKEND, 'scripts/e2e-mint-token.mjs')], { cwd: BACKEND });
  let out = '';
  let err = '';
  p.stdout.on('data', d => (out += d));
  // The minter explains itself on stderr — "No user <email>", a missing
  // JWT_SECRET, an inactive account. Swallowing that turned every cause into
  // the same four words and made a CI-only failure undiagnosable from the
  // annotations alone.
  p.stderr.on('data', d => (err += d));
  p.on('exit', () => {
    const m = out.match(/---E2E_AUTH_BEGIN---\s*([\s\S]*?)\s*---E2E_AUTH_END---/);
    if (!m) {
      const why = err.trim().split(/\r?\n/).filter(Boolean).pop() || 'no output from the minter';
      return reject(new Error(
        `could not mint a token: ${why} ` +
        `(set E2E_LOGIN_EMAIL to an active account that exists on this database)`));
    }
    resolve(JSON.parse(m[1]).token);
  });
});

const server = spawn(process.execPath, [BOOT], { cwd: BACKEND, env: { ...process.env, PORT, SQL_PROBE_LOG: LOG }, stdio: ['ignore','pipe','pipe'] });
const base = `http://localhost:${PORT}/api`;
let bootErr = '';
server.stdout.on('data', d => { bootErr += d; });
server.stderr.on('data', d => { bootErr += d; });

const waitUp = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + '/health')).ok) return true; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
};

let exitCode = 0;
try {
  if (!(await waitUp())) throw new Error(`server did not come up on :${PORT}
` + bootErr.slice(-1200));
  const token = await mintToken();
  const endpoints = discoverGets();
  const byEndpoint = [];
  for (const ep of endpoints) {
    const before = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length;
    await fetch(base + ep, { headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
    await new Promise(r => setTimeout(r, 250));   // let a swallowed rejection land
    const added = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(before).map(JSON.parse);
    if (added.length) byEndpoint.push({ endpoint: ep, failures: added });
  }

  const total = byEndpoint.reduce((n, e) => n + e.failures.length, 0);
  console.log('---REPORT_BEGIN---');
  console.log(JSON.stringify({ endpoints: endpoints.length, failing: byEndpoint.length, failures: total, byEndpoint }, null, 1));
  console.log('---REPORT_END---');
  console.log(`\nSQL failure probe — ${endpoints.length} endpoint(s) called, ${total} query rejection(s) on ${byEndpoint.length} endpoint(s).`);
  for (const e of byEndpoint) {
    console.log(`\n>>> ${e.endpoint}`);
    for (const f of e.failures) console.log(`    [${f.code}] ${f.msg}\n        ${f.sql.slice(0, 160)}`);
  }
  if (total) { console.log('\nFAIL — a rejected query reaches the user as "no data". Fix the SQL, do not widen the catch.'); exitCode = 1; }
  else console.log('\nPASS — no analytics query rejected during the sweep.');
} catch (err) {
  console.error('sql-failure-probe: ' + err.message);
  exitCode = 1;
} finally {
  server.kill();
}
process.exit(exitCode);
