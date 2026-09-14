#!/usr/bin/env node
/**
 * audit-floor-coverage-probe.mjs
 *
 * Asserts that every router mount carrying a mutating handler records its
 * mutations — and proves it by driving the routes, not by reading server.js.
 *
 * WHY
 * ---
 * §8c reported the audit floor as covering "158 of 182 mounts" with "1 mutation
 * mount left uncovered — /auth, deliberately". Re-measured, three mounts with
 * mutating handlers had no floor:
 *
 *   /auth          12 handlers  deliberate — auth_audit_log already covers it,
 *                               and routing credentials into audit_logs would
 *                               be a liability rather than a control
 *   /hr-master      3 handlers  grade / band / skill-category master CRUD
 *   /ai             6 handlers  aiRoutes + aiPayrollRoutes
 *   /api/webhooks   2 handlers  zoho-sign settles a signature;
 *                               razorpay marks an INVOICE PAID
 *
 * The last one is the reason this probe exists. An external caller flipping an
 * invoice to paid, writing payment_transactions, and leaving no audit row is
 * exactly the gap the floor was built to close — and a static count reported it
 * as closed because the count was never re-run.
 *
 * The static half of this probe is deliberately not a grep for `auditMutations`
 * on the mount line: the webhook routes carry the floor PER ROUTE, inside the
 * router, because zoho-sign and razorpay belong to different modules. A mount
 * that grep says is bare can be fully covered. So the static half resolves each
 * uncovered mount to its router file and only complains if that file both
 * mutates and never mentions the floor itself.
 *
 * Usage:
 *   node backend/scripts/audit/audit-floor-coverage-probe.mjs
 *   (expects the API on $PULSE_API or http://localhost:5000/api)
 */
import fsSync from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');          // repo root (…/Pulse)
const BACKEND = path.join(ROOT, 'backend');
const BASE = process.env.PULSE_API || 'http://localhost:5000/api';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

/* ── static: which mutating mounts lack coverage ──────────────────────────── */

// Mounts allowed to carry no floor, each with the reason it is exempt.
const EXEMPT = new Map([
  ['/auth', 'auth_audit_log records sign-in/out, lockout, reset and change; ' +
            'routing credentials into audit_logs would be a liability'],
]);
// Aggregators, not real mounts — `app.use("/api", v1Router)`.
const AGGREGATORS = new Set(['/api', '/api/v1']);

const server = fsSync.readFileSync(path.join(BACKEND, 'server.js'), 'utf8');

const importMap = {};
for (const m of server.matchAll(
  /import\s+(?:(\w+)|\{([^}]*)\})\s+from\s+['"](\.[^'"]+)['"]/g)) {
  const [, dflt, named, file] = m;
  if (dflt) importMap[dflt] = file;
  for (const n of (named || '').split(',')) {
    const id = n.trim().split(' as ').pop().trim();
    if (id) importMap[id] = file;
  }
}

const MUTATING = /\.(post|put|patch|delete)\s*\(/gi;
const mounts = [...server.matchAll(
  /(?:v1Router|app|apiRouter)\.use\(\s*(['"])(\/[^'"]*)\1([^\n]*)/g)];

const uncovered = [];
let covered = 0;
for (const [, , route, rest] of mounts) {
  if (rest.includes('auditMutations')) { covered++; continue; }
  if (AGGREGATORS.has(route) || EXEMPT.has(route)) continue;

  // The router is the LAST identifier on the line that resolves to an import —
  // the first ones are middleware (verifyToken, applyFieldPermissions, aiPolicy).
  const ids = [...rest.matchAll(/\b(\w+)\b/g)]
    .map(m => m[1]).filter(id => importMap[id]);
  if (!ids.length) continue;

  const file = path.resolve(BACKEND, importMap[ids[ids.length - 1]]);
  if (!fsSync.existsSync(file)) continue;
  const src = fsSync.readFileSync(file, 'utf8');
  const handlers = (src.match(MUTATING) || []).length;
  if (!handlers) continue;
  // Covered from inside the router (per-route labels) counts as covered.
  if (src.includes('auditMutations')) { covered++; continue; }
  uncovered.push({ route, handlers, file: path.relative(ROOT, file) });
}

console.log('== every mutating mount records its mutations ==');
check(`mounts carrying the audit floor`, covered > 0, `${covered} of ${mounts.length}`);
check('no mutating mount is left unrecorded',
  uncovered.length === 0,
  uncovered.length
    ? uncovered.map(u => `${u.route} (${u.handlers} handlers, ${u.file})`).join('; ')
    : `${EXEMPT.size} documented exemption(s): ${[...EXEMPT.keys()].join(', ')}`);

/* ── live: the floor actually fires ───────────────────────────────────────── */

const sql = (q) => {
  const f = path.join(BACKEND, 'scripts', 'audit', '_probe.sql');
  fsSync.writeFileSync(f, q, 'utf8');
  try {
    const out = execSync(
      `node "${path.join(HERE, '_q-runner.mjs').split(path.sep).join('/')}" ` +
      `"${f.split(path.sep).join('/')}" ` +
      `"${path.join(BACKEND, 'src', 'config', 'db.js').split(path.sep).join('/')}"`,
      { cwd: BACKEND, encoding: 'utf8' });
    return JSON.parse(out.match(/ROWS:(.*)/)[1]);
  } finally { fsSync.rmSync(f, { force: true }); }
};

const token = (email) => {
  const out = execSync('node backend/scripts/e2e-mint-token.mjs',
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, E2E_LOGIN_EMAIL: email } });
  const parsed = JSON.parse(
    out.split('---E2E_AUTH_BEGIN---')[1].split('---E2E_AUTH_END---')[0].trim());
  return parsed.token;
};

const auditCount = (module) =>
  Number(sql(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE module_name='${module}'`)[0].n);

console.log('\n== /hr-master — 3 mutating handlers that recorded nothing ==');
let created = null;
try {
  const tok = token(process.env.E2E_LOGIN_EMAIL || 'superadmin@manifest.in');
  const before = auditCount('hr');
  const name = `AUDIT-FLOOR-PROBE ${Date.now()}`;
  const res = await fetch(`${BASE}/hr-master/grades`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ name }),
  });
  const body = await res.json().catch(() => ({}));
  created = body?.id ?? null;
  check('the route accepted the mutation', res.status === 201, `status=${res.status}`);

  const after = auditCount('hr');
  check('an audit row was written under module hr', after > before, `${before} → ${after}`);

  // The column is `action_type`, not `action` — audit_logs predates the
  // logAudit({ action }) argument name.
  const row = sql(
    `SELECT action_type, reference_type, user_id FROM audit_logs
      WHERE module_name='hr' ORDER BY id DESC LIMIT 1`)[0];
  check('it names the action and the actor',
    row && row.action_type === 'create' && row.user_id != null,
    row ? `action_type=${row.action_type} actor=${row.user_id}` : 'no row');
} catch (e) {
  check('/hr-master probe ran', false, e.message);
} finally {
  if (created) {
    sql(`DELETE FROM master_grades WHERE id=${Number(created)}`);
    sql(`DELETE FROM audit_logs WHERE module_name='hr' AND new_data_json::text LIKE '%AUDIT-FLOOR-PROBE%'`);
    console.log('  cleaned up the probe grade and its audit rows');
  }
}

console.log('\n== a REJECTED mutation must record nothing ==');
try {
  const tok = token(process.env.E2E_LOGIN_EMAIL || 'superadmin@manifest.in');
  const before = auditCount('hr');
  const res = await fetch(`${BASE}/hr-master/grades`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ description: 'no name — must 400' }),
  });
  const after = auditCount('hr');
  check('the request was refused', res.status === 400, `status=${res.status}`);
  check('and nothing was logged', after === before, `${before} → ${after}`);
} catch (e) {
  check('rejection probe ran', false, e.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
