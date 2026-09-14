/**
 * Authorization regression probe.
 *
 * §157 put `auditMutations` in front of 121 more route mounts. The middleware
 * only wraps res.json, so authorization SHOULD be untouched — but "should" is
 * how the last four passes each produced a defect. This re-runs the exact
 * decisions §154/§155 recorded, so a change shows up as a diff against a
 * published claim rather than as a surprise in production.
 *
 * Two kinds of assertion:
 *   GATED  — the role must be refused (403).
 *   SCOPED — the role gets 200, but must see ONE person: their own record.
 *            This is the measure that matters. A 200 is not a finding; a 200
 *            carrying 34 colleagues' leave balances is.
 */
import { execSync } from 'node:child_process';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file, not hard-coded, so the gate runs from any checkout.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..').split(path.sep).join('/');
const BASE = process.env.PULSE_API || 'http://localhost:5000/api';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function token(email) {
  const out = execSync('node backend/scripts/e2e-mint-token.mjs',
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, E2E_LOGIN_EMAIL: email } });
  const parsed = JSON.parse(out.split('---E2E_AUTH_BEGIN---')[1].split('---E2E_AUTH_END---')[0].trim());
  if (parsed.user.email !== email) throw new Error(`asked for ${email}, got ${parsed.user.email}`);
  return { tok: parsed.token, user: parsed.user };
}

const PS_KILL = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
async function startServer() {
  try { execSync('powershell -NoProfile -Command -', { input: PS_KILL, stdio: ['pipe', 'ignore', 'ignore'] }); }
  catch { /* none */ }
  await sleep(1500);
  const { spawn } = await import('node:child_process');
  spawn('node', ['server.js'], { cwd: ROOT + '/backend', detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    try { if ((await fetch(BASE + '/health')).ok) return; } catch { /* not up */ }
  }
  throw new Error('server did not start');
}

// ⚠ Paced. GLOBAL_RL_MAX defaults to 300/min and a 429 is not an answer about
// authorization — an unpaced sweep once understated this surface fourfold.
let n = 0;
async function get(tok, path) {
  if (++n % 4 === 0) await sleep(300);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${tok}` } });
    if (res.status === 429) { await sleep(2000); continue; }
    let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body };
  }
  return { status: 429, body: null };
}

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

/** Count DISTINCT people a payload describes. The real exposure measure. */
function peopleIn(payload) {
  const ids = new Set();
  const walk = (v, d = 0) => {
    if (d > 6 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(x => walk(x, d + 1));
    for (const k of ['employee_id', 'employeeId', 'emp_id', 'user_id']) {
      if (v[k] != null) ids.add(String(v[k]));
    }
    Object.values(v).forEach(x => walk(x, d + 1));
  };
  walk(payload);
  return ids.size;
}

// By default drive whatever server is already running — a gate that kills the
// developer's server to start its own is worse than the bug it looks for.
// PROBE_RESTART=1 forces a clean instance (what CI wants).
if (process.env.PROBE_RESTART === '1') await startServer();
else {
  try { if (!(await fetch(BASE + '/health')).ok) throw new Error('unhealthy'); }
  catch { console.error('No server on ' + BASE + ' — start one, or run with PROBE_RESTART=1'); process.exit(2); }
}
const emp   = token(process.env.PROBE_LOW_EMAIL || 'test.autoqa@manifest.in');  // plain `employee`
const admin = token(process.env.E2E_LOGIN_EMAIL || 'superadmin@manifest.in');
console.log(`\nemployee = ${emp.user.email} (employee_id ${emp.user.employee_id})`);

// ── GATED: an employee must be refused ──────────────────────────────────────
const GATED = [
  '/probation',
  '/finance/journal-entries',
  '/finance/cfo-dashboard',
  '/customer-portal/accounts',
  '/logistics/shipments',
  '/quality/disturbance-events',
  '/training/skills/matrix',
  '/certifications/employee',
  '/employee-assets',
  '/project-members',
  '/customer-visits',
  '/engineering/ecn/changes',
  '/servicedesk/knowledge',
  '/sales/deal-registrations',
  '/support-mail/inbound',
  '/crm/journeys',
];

console.log('\n== GATED — an ordinary employee must be refused ==');
for (const path of GATED) {
  const r = await get(emp.tok, path);
  check(path.padEnd(34), r.status === 403, `status=${r.status}`);
}

// ── SCOPED: 200 is fine; more than one person is not ─────────────────────────
const SCOPED = ['/leaves/allocations', '/leaves/accrual-history'];

console.log('\n== SCOPED — 200 is allowed, but only their OWN record ==');
for (const path of SCOPED) {
  const asEmp   = await get(emp.tok, path);
  const asAdmin = await get(admin.tok, path);
  const e = peopleIn(asEmp.body), a = peopleIn(asAdmin.body);
  // The discriminator: an endpoint that returns the same population to both is
  // not scoped, whatever its status code says.
  check(`${path.padEnd(28)} employee sees <= 1 person`, e <= 1,
        `employee=${e} people, admin=${a} people (status ${asEmp.status})`);
}

// ── OPEN by design ───────────────────────────────────────────────────────────
console.log('\n== OPEN by design — company reference material ==');
for (const path of ['/hr/policies']) {
  const r = await get(emp.tok, path);
  check(`${path.padEnd(34)} still reachable`, r.status === 200, `status=${r.status}`);
}

// ── the admin side still works (a gate that blocks everyone is an outage) ────
console.log('\n== the people who own these modules are NOT locked out ==');
const ADMIN_MUST_SEE = [
  '/probation', '/training/skills/matrix', '/employee-assets',
  '/servicedesk/knowledge', '/sales/deal-registrations', '/crm/journeys',
  '/support-mail/inbound', '/finance/journal-entries',
];
for (const path of ADMIN_MUST_SEE) {
  const r = await get(admin.tok, path);
  check(path.padEnd(34), r.status === 200, `status=${r.status}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
