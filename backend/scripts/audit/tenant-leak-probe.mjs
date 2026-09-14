/**
 * tenant-leak-probe.mjs — call every Analytics & AI endpoint as a Company A
 * admin and a Company B admin, and look for each tenant's data in the other's
 * response.
 *
 * Both fixtures hold the SAME role (`admin`), so permissions are identical and
 * any difference in what comes back is scoping and nothing else. Company B's
 * rows all carry the literal 'ZZTENANT' in a text column, and its numeric
 * values (7777777 invoice, 8888888 opportunity, 9999999 budget) are distinctive
 * enough to spot inside an aggregate where no string would survive.
 *
 * With one company in the database, every cross-tenant claim is unfalsifiable:
 * a query that ignores company_id entirely still returns the right answer.
 * Requires `tenant-fixture.mjs --up` to have run.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';

const BACKEND = path.resolve(import.meta.dirname, '..', '..');
dotenv.config({ path: path.join(BACKEND, '.env'), quiet: true });
const pool = (await import(pathToFileURL(path.join(BACKEND, 'src/config/db.js')).href)).default;
const SECRET = process.env.JWT_SECRET;
// Default to the same base the rest of the E2E suite drives (PULSE_API, which
// CI sets to the app under test) rather than a private port. The old default of
// :5099 was a port nothing starts: the Playwright case that runs this probe
// passed only when someone happened to have a server there, and failed with
// ECONNREFUSED the moment they did not — a harness dependency that looked like
// a product failure. PROBE_API still overrides, for pointing at a scratch
// instance deliberately.
const API = process.env.PROBE_API || process.env.PULSE_API || 'http://localhost:5000/api/v1';

const MARK = 'ZZTENANT';
// Values that exist ONLY in Company B. If one turns up in a Company A response,
// an aggregate crossed the tenant boundary even though no string leaked.
const B_NUMBERS = [7777777, 8888888, 9999999];

/**
 * ENDPOINTS — discovered from the route files, never hand-listed.
 *
 * This used to be a literal array of 68 paths against a surface of 122. The gap
 * was not visible from the list itself, and one of the routers it omitted
 * entirely — /analytics/pq/* — had ZERO company scoping across all eight of its
 * endpoints. The probe passed the whole time, because it never asked.
 *
 * Deriving the list from the same route files the server mounts means a new
 * endpoint is probed the day it is written, and the count below fails loudly if
 * discovery ever returns less than the surface it is supposed to cover.
 */
const ROUTE_FILES = [
  ['/ai',                      'src/modules/intelligence/ai.routes.js'],
  ['/ai',                      'src/modules/analytics/aiPayroll.routes.js'],
  ['/intelligence',            'src/modules/intelligence/intelligence.routes.js'],
  ['/ceo-intelligence',        'src/modules/intelligence/ceo-intelligence.routes.js'],
  ['/analytics',               'src/analytics/routes/analytics.routes.js'],
  ['/analytics/pq',            'src/analytics/routes/powerQuality.routes.js'],
  ['/analytics/manufacturing', 'src/analytics/routes/manufacturing.routes.js'],
  ['/dashboard',               'src/modules/dashboard/dashboard.routes.js'],
  ['/user-dashboard',          'src/modules/analytics/user-dashboard.routes.js'],
];

function discoverEndpoints() {
  const out = [];
  for (const [prefix, rel] of ROUTE_FILES) {
    const src = fs.readFileSync(path.join(BACKEND, rel), 'utf8');
    for (const m of src.matchAll(/router\.get\(\s*["'`]([^"'`]*)["'`]/g)) {
      const p = m[1] === '/' ? '' : m[1];
      if (prefix === '/analytics' && (p.startsWith('/pq') || p.startsWith('/manufacturing'))) continue;
      // Path params get a value that exists in neither tenant, so a 404 here is
      // an honest miss rather than a cross-tenant read.
      out.push((prefix + p).replace(/:(\w+)/g, (s, n) => (n.toLowerCase().includes('id') ? '1' : 'x')));
    }
  }
  const list = [...new Set(out)];
  if (list.length < 100) {
    console.error(`FAIL — discovery found only ${list.length} endpoints; the Analytics & AI surface is larger than that. Check ROUTE_FILES.`);
    process.exit(1);
  }
  return list;
}

const ENDPOINTS = discoverEndpoints();

async function tokenForEmail(email) {
  const { rows: [u] } = await pool.query(
    'SELECT id, email, role, employee_id, company_id FROM users WHERE email=$1', [email]);
  if (!u) throw new Error(`no user ${email}`);
  const { rows: rr } = await pool.query(
    'SELECT LOWER(r.code) c FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1', [u.id]);
  return {
    token: jwt.sign({
      userId: u.id, email: u.email, role: u.role, roles: rr.map((x) => x.c),
      employeeId: u.employee_id, company_id: u.company_id,
    }, SECRET, { expiresIn: '2h' }),
    company_id: u.company_id, roles: rr.map((x) => x.c),
  };
}

/**
 * PACING — the server rate-limits at 300 requests/minute.
 *
 * When the endpoint list was 68 paths a 120ms gap was comfortably under it. Now
 * that the list is discovered (121 paths, two tenants = 242 requests) 120ms is
 * 8/s, which trips the limiter partway through the second sweep. A 429 is
 * indistinguishable from "this tenant cannot reach the endpoint", so it turns a
 * rate-limit into either a false leak-free PASS or a phantom access failure —
 * exactly the trap this probe exists to avoid.
 *
 * 250ms holds 4/s, and any 429 that still lands is retried after a full window
 * rather than recorded. A 429 that survives the retry is reported as-is: it must
 * be visible, never smoothed over.
 */
const RATE_LIMIT_PER_MIN = 300;
const GAP_MS = Math.ceil(60000 / (RATE_LIMIT_PER_MIN * 0.8));   // 250ms at 300/min
// Time to let the limiter's window drain: between the two tenant sweeps (from
// the server's point of view they are one continuous burst) and after a 429.
const WINDOW_DRAIN_MS = 61000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callOnce(ep, token) {
  const r = await fetch(API + ep, { headers: { Authorization: 'Bearer ' + token } });
  return { code: r.status, body: r.status === 200 ? await r.text() : '' };
}

async function sweep(label, token) {
  const out = {};
  let throttled = 0;
  for (const ep of ENDPOINTS) {
    await sleep(GAP_MS);
    try {
      let res = await callOnce(ep, token);
      if (res.code === 429) {
        throttled++;
        process.stderr.write(`  (429 on ${ep} — waiting out the window)\n`);
        await sleep(WINDOW_DRAIN_MS);
        res = await callOnce(ep, token);
      }
      out[ep] = res;
    } catch (e) {
      out[ep] = { code: -1, body: '', error: e.message };
    }
  }
  process.stderr.write(`  swept ${label}${throttled ? ` (${throttled} retried after a 429)` : ''}\n`);
  return out;
}


const A_EMAIL = process.env.TENANT_A_EMAIL || 'admin@manifest.in';
const B_EMAIL = process.env.TENANT_B_EMAIL || 'zztenant.b@zztenant.invalid';

const A = await tokenForEmail(A_EMAIL);
const B = await tokenForEmail(B_EMAIL);
if (A.company_id === B.company_id) throw new Error('fixtures share a company — nothing to isolate');

const aRes = await sweep(`A (company ${A.company_id})`, A.token);
await sleep(WINDOW_DRAIN_MS);
const bRes = await sweep(`B (company ${B.company_id})`, B.token);

/**
 * A body is "trivial" when it carries no actual measurement — `[]`, `{}`, or a
 * structure whose every number is zero. Two tenants legitimately produce the
 * same trivial body, so those are not evidence of a missing filter.
 */
/**
 * A response that carries no tenant data cannot demonstrate a leak by being
 * identical across tenants — two empty results are identical for the honest
 * reason. Beyond "short" and "all zeros", this now recognises the explicit
 * empty-state contracts the module emits (no_data / insufficient_history /
 * DATA_UNAVAILABLE) and payloads whose every array is empty, which is what an
 * endpoint returns when neither tenant has any rows.
 *
 * Widening this is only safe because the marker check above runs independently:
 * a body containing Company B's ZZTENANT string is reported no matter what this
 * function says.
 */
// Keys that carry the shape of a chart rather than a measurement: axis labels,
// week and month indices, series names. A response made entirely of these plus
// zeros is an empty chart, not leaked data.
const AXIS_KEYS = new Set(['label','labels','month','months','week','weeks','day','days',
  'name','names','category','categories','period','period_label','year','quarter','stage','type']);

/** True when no numeric leaf outside AXIS_KEYS is non-zero. */
function allMeasuresZero(node, key = null) {
  if (node == null) return true;
  if (typeof node === 'number') return AXIS_KEYS.has(String(key)) || node === 0;
  if (typeof node === 'string' || typeof node === 'boolean') return true;
  if (Array.isArray(node)) return node.every(v => allMeasuresZero(v, key));
  return Object.entries(node).every(([k, v]) => allMeasuresZero(v, k));
}

function isTrivial(body) {
  if (body.length <= 2) return true;
  let j;
  try { j = JSON.parse(body); } catch { return /^[^0-9]*0*[^0-9]*$/.test(body); }
  if (Array.isArray(j) && j.length === 0) return true;
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    if (j.no_data === true || j.insufficient_history === true) return true;
    if (j.status === 'DATA_UNAVAILABLE' || j.degraded === true) return true;
  }
  return allMeasuresZero(j);
}

/**
 * Endpoints whose backing tables carry NO company_id in the schema, verified
 * against information_schema: `role_permissions`, `field_permissions` and
 * `workflow_master` are the application-wide RBAC and workflow catalogue, the
 * same for every tenant by design.
 *
 * This list is deliberately tiny and each entry names the reason. It is NOT a
 * place to silence a finding — if a table here ever gains a company_id, delete
 * the entry and scope the query.
 */
const SCHEMA_GLOBAL = new Map([
  ['/intelligence/role-permissions',  'role_permissions has no company_id — global RBAC catalogue'],
  ['/intelligence/field-permissions', 'field_permissions has no company_id — global RBAC catalogue'],
  ['/intelligence/workflows',         'workflow_master has no company_id — global workflow catalogue'],
]);

const findings = [];
for (const ep of ENDPOINTS) {
  const a = aRes[ep];
  const b = bRes[ep];

  if (a.code === 200 && a.body.includes(MARK)) {
    const i = a.body.indexOf(MARK);
    findings.push({
      ep, kind: 'B-marker-in-A',
      sample: a.body.slice(Math.max(0, i - 70), i + 70),
    });
  }

  for (const n of B_NUMBERS) {
    if (a.code === 200 && new RegExp(`\\b${n}\\b`).test(a.body)) {
      findings.push({ ep, kind: `B-value-in-A`, value: n });
    }
  }

  // A non-trivial response byte-identical across two different tenants means the
  // query ignored company_id.
  if (a.code === 200 && b.code === 200 && a.body === b.body
      && !isTrivial(a.body) && !SCHEMA_GLOBAL.has(ep)) {
    findings.push({
      ep, kind: 'identical-across-tenants',
      len: a.body.length, sample: a.body.slice(0, 200),
    });
  }
}

const report = {
  company_a: A.company_id,
  company_b: B.company_id,
  a_roles: A.roles,
  b_roles: B.roles,
  endpoints: ENDPOINTS.length,
  a_status: Object.fromEntries(ENDPOINTS.map((e) => [e, aRes[e].code])),
  b_status: Object.fromEntries(ENDPOINTS.map((e) => [e, bRes[e].code])),
  findings,
};
fs.writeFileSync(process.env.PROBE_OUT || 'tenant-leaks.json', JSON.stringify(report, null, 2));
console.log('---REPORT_BEGIN---');
console.log(JSON.stringify({
  findings: findings.length,
  byKind: findings.reduce((m, f) => { m[f.kind] = (m[f.kind] || 0) + 1; return m; }, {}),
}));
console.log('---REPORT_END---');
await pool.end();
