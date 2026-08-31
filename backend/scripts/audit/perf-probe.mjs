/**
 * perf-probe.mjs — latency and payload size for every Analytics & AI endpoint.
 *
 * Reports p50/p95/p99 per endpoint over N samples, plus response size. Warms
 * each endpoint once before measuring so a cold pool/plan-cache does not land in
 * the sample, and paces requests under the server's 300/min limit so a 429 is
 * never timed as if it were the endpoint.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';

const BACKEND = path.resolve(import.meta.dirname, '..', '..');
dotenv.config({ path: path.join(BACKEND, '.env'), quiet: true });
const pool = (await import(pathToFileURL(path.join(BACKEND, 'src/config/db.js')).href)).default;
// Default to the same base the rest of the E2E suite drives (PULSE_API, which
// CI sets to the app under test) rather than a private port. The old default of
// :5099 was a port nothing starts: the Playwright case that runs this probe
// passed only when someone happened to have a server there, and failed with
// ECONNREFUSED the moment they did not — a harness dependency that looked like
// a product failure. PROBE_API still overrides, for pointing at a scratch
// instance deliberately.
const API = process.env.PROBE_API || process.env.PULSE_API || 'http://localhost:5000/api/v1';
const SAMPLES = Number(process.env.PERF_SAMPLES || 7);

const ENDPOINTS = [
  '/analytics/headcount', '/analytics/attrition', '/analytics/dept-workforce',
  '/analytics/hr-benchmarks', '/analytics/salary-bands', '/analytics/top-performers',
  '/analytics/ceo/kpis', '/analytics/sales', '/analytics/hr-filter-options',
  '/analytics/manufacturing/work-centre', '/analytics/manufacturing/scrap-rate',
  '/dashboard/cfo?period=YTD', '/dashboard/finance', '/dashboard/cash',
  '/dashboard/revenue', '/dashboard/sales', '/dashboard/operations',
  '/dashboard/top-customers', '/dashboard/top-vendors', '/dashboard/project-health',
  '/dashboard/data', '/dashboard/summary', '/dashboard/live-kpis',
  '/ai/predictions', '/ai/anomalies', '/ai/prescriptive',
  '/ai/payroll/trends', '/ai/cashflow/forecast',
  '/ceo-intelligence/executive-summary', '/ceo-intelligence/customers',
  '/ceo-intelligence/vendors', '/ceo-intelligence/projects',
  '/ceo-intelligence/collections', '/ceo-intelligence/service-amc',
  '/ceo-intelligence/strategic-alerts', '/ceo-intelligence/ai-insights',
  '/ceo-intelligence/manifest',
];

const { rows: [u] } = await pool.query(
  "SELECT id, email, role, employee_id, company_id FROM users WHERE email = $1",
  [process.env.PERF_EMAIL || 'superadmin@manifest.in']);
const { rows: rr } = await pool.query(
  'SELECT LOWER(r.code) c FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1', [u.id]);
const TOKEN = jwt.sign({
  userId: u.id, email: u.email, role: u.role, roles: rr.map((x) => x.c),
  employeeId: u.employee_id, company_id: u.company_id,
}, process.env.JWT_SECRET, { expiresIn: '2h' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const rows = [];
for (const ep of ENDPOINTS) {
  // Warm-up, not measured: first hit pays for pool checkout and plan caching.
  await sleep(120);
  await fetch(API + ep, { headers: { Authorization: 'Bearer ' + TOKEN } }).catch(() => {});

  const times = [];
  let bytes = 0, status = 0;
  for (let i = 0; i < SAMPLES; i++) {
    await sleep(120);
    const t0 = performance.now();
    try {
      const r = await fetch(API + ep, { headers: { Authorization: 'Bearer ' + TOKEN } });
      const body = await r.text();
      const dt = performance.now() - t0;
      status = r.status;
      if (r.status === 429) { i--; await sleep(3_000); continue; }
      bytes = body.length;
      times.push(dt);
    } catch { /* counted as a miss, not a timing */ }
  }
  if (!times.length) { rows.push({ ep, status, error: 'no samples' }); continue; }
  rows.push({
    ep, status, samples: times.length,
    p50: Math.round(pct(times, 50)),
    p95: Math.round(pct(times, 95)),
    p99: Math.round(pct(times, 99)),
    max: Math.round(Math.max(...times)),
    kb: Math.round(bytes / 102.4) / 10,
  });
  process.stderr.write(`  ${ep.padEnd(46)} p50=${rows.at(-1).p50}ms p95=${rows.at(-1).p95}ms ${rows.at(-1).kb}KB\n`);
}

const ok = rows.filter((r) => r.p50 != null);
const summary = {
  endpoints: rows.length,
  samples_each: SAMPLES,
  slowest: [...ok].sort((a, b) => b.p95 - a.p95).slice(0, 8),
  overall_p50: Math.round(pct(ok.map((r) => r.p50), 50)),
  overall_p95: Math.round(pct(ok.map((r) => r.p95), 95)),
  over_1s_p95: ok.filter((r) => r.p95 > 1000).map((r) => r.ep),
  largest: [...ok].sort((a, b) => b.kb - a.kb).slice(0, 5).map((r) => ({ ep: r.ep, kb: r.kb })),
};

fs.writeFileSync(process.env.PERF_OUT || 'perf-report.json', JSON.stringify({ rows, summary }, null, 2));
console.log('---REPORT_BEGIN---');
console.log(JSON.stringify(summary));
console.log('---REPORT_END---');
await pool.end();
