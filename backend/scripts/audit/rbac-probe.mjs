/**
 * RBAC probe — mint a token per role and GET every Analytics & AI endpoint.
 * Emits a JSON matrix. Read-only: only GET, plus explicitly listed safe POSTs.
 */
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';

const BACKEND = 'c:/Users/malar/OneDrive/Desktop/Pulse_WORKING/Pulse/backend';
dotenv.config({ path: path.join(BACKEND, '.env'), quiet: true });
const pool = (await import(`file:///${BACKEND}/src/config/db.js`)).default;
const SECRET = process.env.JWT_SECRET;
// Default to the same base the rest of the E2E suite drives (PULSE_API, which
// CI sets to the app under test) rather than a private port. The old default of
// :5099 was a port nothing starts: the Playwright case that runs this probe
// passed only when someone happened to have a server there, and failed with
// ECONNREFUSED the moment they did not — a harness dependency that looked like
// a product failure. PROBE_API still overrides, for pointing at a scratch
// instance deliberately.
const API = process.env.PROBE_API || process.env.PULSE_API || 'http://localhost:5000/api/v1';

const ENDPOINTS = [
  // ── /analytics (analyticsPolicy) ──
  ['/analytics/headcount','hr:view'], ['/analytics/attrition','hr:view'],
  ['/analytics/dept-workforce','hr:view'], ['/analytics/gender','hr:view'],
  ['/analytics/attrition-trend','hr:view'], ['/analytics/hiring-trend','hr:view'],
  ['/analytics/absenteeism','hr:view'], ['/analytics/productivity','hr:view'],
  ['/analytics/insights/hr','hr:view'], ['/analytics/headcount-trend','hr:view'],
  ['/analytics/onboarding','hr:view'], ['/analytics/compliance-alerts','hr:view'],
  ['/analytics/hr-filter-options','hr:view'], ['/analytics/age-distribution','hr:view'],
  ['/analytics/top-performers','hr:view'],
  ['/analytics/salary-bands','payroll:view'], ['/analytics/hr-benchmarks','payroll:view'],
  ['/analytics/satisfaction','performance:view'],
  ['/analytics/ceo/kpis','finance:view'],
  ['/analytics/sales','crm:view'],
  ['/analytics/offer-acceptance','recruitment:view'], ['/analytics/time-to-hire','recruitment:view'],
  ['/analytics/manufacturing/work-centre','production:view'],
  ['/analytics/manufacturing/scrap-rate','production:view'],
  ['/analytics/employee-reports/headcount','hr:view'],
  ['/analytics/employee-reports/salary-bands','hr:view'],
  // ── /dashboard (dashboardPolicy) ──
  ['/dashboard/cfo','finance:view'], ['/dashboard/finance','finance:view'],
  ['/dashboard/revenue','finance:view'], ['/dashboard/expenses','finance:view'],
  ['/dashboard/cash','finance:view'],
  ['/dashboard/top-customers','crm:view'], ['/dashboard/sales','crm:view'],
  ['/dashboard/top-vendors','procurement:view'],
  ['/dashboard/workforce','hr:view'], ['/dashboard/hires','hr:view'],
  ['/dashboard/headcount-trend','hr:view'],
  ['/dashboard/leave-summary','leave:view'],
  ['/dashboard/manufacturing','production:view'],
  ['/dashboard/project-health','projects:view'],
  ['/dashboard/data','reports:view'], ['/dashboard/insights','reports:view'],
  ['/dashboard/alerts','reports:view'], ['/dashboard/operations','reports:view'],
  ['/dashboard/activity','reports:view'], ['/dashboard/approvals','reports:view'],
  ['/dashboard/summary','reports:view'], ['/dashboard/live-kpis','reports:view'],
  ['/dashboard/celebrations','OPEN'], ['/dashboard/celebrations-today','OPEN'],
  // ── /ai (aiPolicy) ──
  ['/ai/predict/attrition','hr:view'], ['/ai/predict/sales','crm:view'],
  ['/ai/predict/lead-priority','crm:view'], ['/ai/predict/inventory','inventory:view'],
  ['/ai/predict/quality-risk','quality:view'], ['/ai/predict/device-failure','iot:view'],
  ['/ai/payroll/trends','payroll:view'], ['/ai/payroll/departments','payroll:view'],
  ['/ai/payroll/anomalies','payroll:view'],
  ['/ai/cashflow/forecast','finance:view'],
  ['/ai/anomalies','reports:view'], ['/ai/predictions','reports:view'],
  ['/ai/prescriptive','reports:view'], ['/ai/smart-search','reports:view'],
  // ── /ceo-intelligence (per-route requirePermission) ──
  ['/ceo-intelligence/executive-summary','crm:view'],
  ['/ceo-intelligence/customers','crm:view'],
  ['/ceo-intelligence/service-amc','crm:view'],
  ['/ceo-intelligence/strategic-alerts','crm:view'],
  ['/ceo-intelligence/ai-insights','crm:view'],
  ['/ceo-intelligence/vendors','procurement:view'],
  ['/ceo-intelligence/projects','projects:view'],
  ['/ceo-intelligence/manifest','projects:view'],
  ['/ceo-intelligence/collections','finance:view'],
  // ── /intelligence (intelligencePolicy, newly added) ──
  ['/intelligence/roles','admin:view'], ['/intelligence/rules','admin:view'],
  ['/intelligence/companies','admin:view'], ['/intelligence/audit-logs','audit:view'],
];

const { rows: roleRows } = await pool.query(`
  SELECT LOWER(r.code) AS role, MIN(u.id) AS uid
    FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN users u ON u.id=ur.user_id
   WHERE u.is_active GROUP BY 1 ORDER BY 1`);

async function tokenFor(uid) {
  const { rows: [u] } = await pool.query(
    'SELECT id, email, role, employee_id FROM users WHERE id=$1', [uid]);
  const { rows: rr } = await pool.query(
    'SELECT LOWER(r.code) c FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1', [uid]);
  const roles = rr.map(x => x.c);
  return { token: jwt.sign(
    { userId: u.id, email: u.email, role: u.role, roles, employeeId: u.employee_id },
    SECRET, { expiresIn: '2h' }), email: u.email, roles };
}

/**
 * The server applies a global 300-req/min memory rate limit keyed per client.
 * A 26-role x 79-endpoint sweep is ~2 000 requests, so an unpaced run collects
 * 429s from role five onward and reports "no access" for roles that in fact have
 * it — a false PASS on the security matrix. Pacing keeps every response a real
 * authorization decision. Override with PROBE_RL_MAX / PROBE_RL_WINDOW_MS to
 * match a differently configured server.
 */
const RL_MAX    = parseInt(process.env.PROBE_RL_MAX || '300', 10);
const RL_WINDOW = parseInt(process.env.PROBE_RL_WINDOW_MS || '60000', 10);
// Stay comfortably under the cap: 80% of the budget, spread evenly.
const GAP_MS = Math.ceil(RL_WINDOW / (RL_MAX * 0.8));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with pacing, and one retry that honours Retry-After if we still hit 429. */
async function paced(url, headers) {
  await sleep(GAP_MS);
  let r = await fetch(url, headers ? { headers } : undefined);
  if (r.status === 429) {
    const wait = (parseInt(r.headers.get('retry-after') || '0', 10) || 5) * 1000 + 500;
    process.stderr.write(`  rate limited; waiting ${wait}ms
`);
    await sleep(wait);
    r = await fetch(url, headers ? { headers } : undefined);
  }
  return r;
}

const matrix = {};
for (const { role, uid } of roleRows) {
  const { token, email, roles } = await tokenFor(uid);
  matrix[role] = { email, roles, results: {} };
  for (const [ep] of ENDPOINTS) {
    let code = 0, note = '';
    try {
      const r = await paced(API + ep, { Authorization: 'Bearer ' + token });
      code = r.status;
      if (code >= 400) { const t = await r.text(); note = t.slice(0, 90); }
    } catch (e) { code = -1; note = e.message; }
    matrix[role].results[ep] = { code, note };
  }
  process.stderr.write(`  probed ${role}\n`);
}

// Unauthenticated + garbage-token baseline
const anon = { results: {} }, bad = { results: {} };
for (const [ep] of ENDPOINTS) {
  anon.results[ep] = { code: (await paced(API + ep)).status };
  bad.results[ep]  = { code: (await paced(API + ep, { Authorization: 'Bearer not.a.token' })).status };
}
matrix['(anonymous)'] = anon;
matrix['(bad-token)'] = bad;

fs.writeFileSync(process.env.PROBE_OUT || 'rbac-matrix.json',
  JSON.stringify({ endpoints: ENDPOINTS, matrix }, null, 2));
console.log('done ->', process.env.PROBE_OUT || 'rbac-matrix.json');
await pool.end();
