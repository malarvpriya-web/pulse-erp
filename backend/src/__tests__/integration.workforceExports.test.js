/**
 * Workforce Analytics & Reports — the three CSV exports.
 *
 *   GET /api/analytics/employee-reports/headcount
 *   GET /api/analytics/employee-reports/attrition
 *   GET /api/analytics/employee-reports/doc-expiry?window=…
 *
 * Real database, real analyticsPolicy and router (the caller is stubbed as the
 * other analytics suites do). Fixtures live in test companies 999939 (own) and
 * 999940 (foreign) — see testTenantIds.contract.test.js — and are cleared at
 * the start of the run as well as the end, so an interrupted run cannot block
 * the next one.
 *
 * Pins: authorization and company scope; the page's filters; the period
 * (attrition only — headcount is "as of today"); unknown exit dates stay
 * 'Unknown' (never updated_at); the expiry window is explicit; soft-deleted
 * employees, other companies' documents and mismatched-company documents are
 * excluded; empty results are 200 with no rows; and no salary, ID number, bank,
 * contact, file link or note ever appears in a response.
 * CSV writing (formula quoting, Aadhaar masking) happens in the browser and is
 * tested in frontend/src/__tests__/workforceAnalytics.exports.test.jsx.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbToday, addDays } from './helpers/dbDate.js';

const here = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }            = await import('../config/db.js');
const { analyticsPolicy }          = await import('../shared/analyticsAuthz.js');
const { default: analyticsRoutes } = await import('../analytics/routes/analytics.routes.js');
const { WORKFORCE_EXPORT_COLUMNS } = await import('../employees/employee.service.js');

const OWN = 999939;
const FOREIGN = 999940;
const PROBE_USER_ID = -424245;      // owns no user-level permission override (checked)
const BASE = '/api/analytics/employee-reports';

function appAs(roles, scope = { company_id: OWN }) {
  const a = express();
  a.use((req, _res, next) => {
    if (roles) {
      req.user = { userId: PROBE_USER_ID, id: PROBE_USER_ID, roles, role: roles[0], company_id: scope?.company_id ?? null };
      req.scope = scope;
    }
    next();
  });
  a.use('/api/analytics', analyticsPolicy, analyticsRoutes);
  return a;
}
const get = (path, query = {}, roles = ['hr_exec'], scope) =>
  request(appAs(roles, scope)).get(`${BASE}${path}`).query(query);

const YEAR = { from: '2026-01-01', to: '2026-12-31' };
// offsets from the DATABASE's today (helpers/dbDate.js) — the date Days Left is computed against
let TODAY;
const day = (offset) => addDays(TODAY, offset);
const col = (res, name) => res.body.rows.map(r => r[res.body.columns.indexOf(name)]);

// Values that must never leave the server in any export.
const SECRETS = {
  pan: 'ZZPAN1234Z', aadhaar: '234567890123', account: '998877665544',
  phone: '9876501234', salary: '73456', fileUrl: '/uploads/zz-secret-scan.pdf',
  driveUrl: 'https://drive.example/zz-secret', note: 'zz secret note',
};
function expectNoSecrets(res) {
  const text = JSON.stringify(res.body);
  for (const [k, v] of Object.entries(SECRETS)) expect(text, k).not.toContain(v);
  expect(text).not.toMatch(/"(pan_number|aadhaar_number|account_number|ifsc_code|basic_salary|file_url|drive_url|notes|phone)"/);
}

const emp = {};
let branchId;

async function cleanFixtures() {
  await pool.query(`DELETE FROM employee_documents WHERE company_id IN ($1, $2)
                       OR employee_id IN (SELECT id FROM employees WHERE company_id IN ($1, $2))`, [OWN, FOREIGN]);
  await pool.query(`DELETE FROM exit_requests WHERE employee_id IN
                      (SELECT id FROM employees WHERE company_id IN ($1, $2))`, [OWN, FOREIGN]);
  await pool.query(`DELETE FROM employees WHERE company_id IN ($1, $2)`, [OWN, FOREIGN]);
  await pool.query(`DELETE FROM branches WHERE company_id = $1`, [OWN]);
}

async function addEmployee(key, company_id, office_id, fields) {
  const cols = ['company_id', 'office_id', ...Object.keys(fields)];
  const vals = [company_id, office_id, ...Object.values(fields)];
  const { rows } = await pool.query(
    `INSERT INTO employees (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, vals);
  emp[key] = rows[0].id;
}

async function addDoc(employeeKey, company_id, fields) {
  await pool.query(
    `INSERT INTO employee_documents (employee_id, company_id, document_type, document_name, expiry_date, status, file_url, drive_url, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [emp[employeeKey], company_id, fields.type, fields.name, fields.expiry, fields.status ?? 'active',
     SECRETS.fileUrl, SECRETS.driveUrl, SECRETS.note]);
}

beforeAll(async () => {
  TODAY = await dbToday(pool);
  const { rows: ov } = await pool.query('SELECT COUNT(*)::int AS n FROM permissions WHERE user_id = $1', [PROBE_USER_ID]);
  expect(ov[0].n).toBe(0);
  for (const [id, code] of [[OWN, 'ZZWXA'], [FOREIGN, 'ZZWXB']]) {
    await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [id, `${code} Export Fixture`, code]);
  }
  await cleanFixtures();
  ({ rows: [{ id: branchId }] } = await pool.query(
    `INSERT INTO branches (company_id, name, code) VALUES ($1, 'ZZWX Depot', $2) RETURNING id`, [OWN, `ZZWX${Date.now()}`]));

  const sensitive = { pan_number: SECRETS.pan, aadhaar_number: SECRETS.aadhaar, account_number: SECRETS.account,
                      phone: SECRETS.phone, basic_salary: SECRETS.salary };
  // Current (3)
  await addEmployee('e1', OWN, 'EMP99993901', { first_name: 'ZZWX', last_name: 'Alpha', status: 'Active',
    department: 'Ops', designation: 'Driver', employment_type: 'Permanent', branch_id: branchId,
    joining_date: '2024-01-10', ...sensitive });
  await addEmployee('e2', OWN, 'EMP99993902', { first_name: 'ZZWX', last_name: 'Beta', status: 'Probation',
    department: '', designation: '=HYPERLINK("http://evil","x")', joining_date: '2026-05-01' });
  await addEmployee('e3', OWN, 'EMP99993903', { first_name: 'ZZWX', last_name: 'Gamma', status: 'Active',
    department: 'Admin', joining_date: '2026-02-01' });
  // Exited (4)
  await addEmployee('x1', OWN, 'EMP99993911', { first_name: 'ZZWX', last_name: 'Left Dated', status: 'Left',
    department: 'Ops', exit_date: '2026-06-30', exit_reason: 'Better offer', joining_date: '2025-03-01' });
  await addEmployee('x2', OWN, 'EMP99993912', { first_name: 'ZZWX', last_name: 'Left Undated', status: 'resigned',
    department: 'Ops', joining_date: '2025-04-01', updated_at: '2026-07-15' });
  await addEmployee('x3', OWN, 'EMP99993913', { first_name: 'ZZWX', last_name: 'Left Request', status: 'Left',
    department: 'Admin', joining_date: '2025-05-01' });
  await pool.query(`INSERT INTO exit_requests (employee_id, reason, last_working_date, status)
                    VALUES ($1, 'Relocation', '2026-08-10', 'approved')`, [emp.x3]);
  await addEmployee('x4', OWN, 'EMP99993914', { first_name: 'ZZWX', last_name: 'Left Long Ago', status: 'Left',
    department: 'Ops', exit_date: '2025-01-15', exit_reason: 'Old exit', joining_date: '2024-01-01' });
  // Soft-deleted
  await addEmployee('del', OWN, 'EMP99993921', { first_name: 'ZZWX', last_name: 'Deleted', status: 'Active',
    department: 'Ops', joining_date: '2025-01-01', deleted_at: '2026-09-01' });
  // Foreign company
  await addEmployee('f1', FOREIGN, 'EMP99994001', { first_name: 'ZZWX', last_name: 'Foreigner', status: 'Active',
    department: 'Ops', joining_date: '2025-01-01' });
  await addEmployee('f2', FOREIGN, 'EMP99994002', { first_name: 'ZZWX', last_name: 'Foreign Leaver', status: 'Left',
    department: 'Ops', exit_date: '2026-06-15', joining_date: '2025-01-01' });

  // Documents
  await addDoc('e1', OWN, { type: 'Aadhar Card', name: 'Aadhar Card 2345 6789 0123', expiry: day(-1) });   // expired
  await addDoc('e1', OWN, { type: 'Passport', name: 'Passport', expiry: day(20), status: 'verified' });   // next30
  await addDoc('e3', OWN, { type: 'Driving License', name: 'Licence', expiry: day(45) });                 // next60
  await addDoc('e3', OWN, { type: 'Other', name: 'Far Future', expiry: day(200) });                        // none
  await addDoc('e3', OWN, { type: 'Other', name: 'No Expiry', expiry: null });                             // none
  await addDoc('del', OWN, { type: 'Passport', name: 'Deleted Employee Doc', expiry: day(-5) });           // excluded
  await addDoc('e1', FOREIGN, { type: 'Other', name: 'Mismatched Company Doc', expiry: day(-3) });         // excluded
  await addDoc('f1', FOREIGN, { type: 'Passport', name: 'Foreign Doc', expiry: day(-2) });                 // other tenant
}, 30000);

afterAll(async () => { await cleanFixtures(); });

// ── Authorization and scope ───────────────────────────────────────────────────
describe('authorization and company scope', () => {
  const paths = [['/headcount', {}], ['/attrition', YEAR], ['/doc-expiry', { window: 'expired' }]];

  it.each(paths)('%s: hr:view is allowed', async (path, q) => {
    expect((await get(path, q, ['hr_exec'])).status).toBe(200);
  });

  it.each(paths)('%s: payroll:view without hr:view is denied, with no rows', async (path, q) => {
    const res = await get(path, q, ['finance_manager']);
    expect(res.status).toBe(403);
    expect(res.body.rows).toBeUndefined();
  });

  it.each(paths)('%s: employee is denied', async (path, q) => {
    expect((await get(path, q, ['employee'])).status).toBe(403);
  });

  it.each(paths)('%s: unauthenticated is 401', async (path, q) => {
    expect((await get(path, q, null)).status).toBe(401);
  });

  it.each(paths)('%s: no company scope is refused, not "every company"', async (path, q) => {
    const res = await get(path, q, ['hr_exec'], { company_id: null });
    expect(res.status).toBe(403);
    expect(res.body.rows).toBeUndefined();
  });

  it.each(paths)('%s: never another company\'s rows', async (path, q) => {
    const res = await get(path, { ...q, period: 'all', from: undefined, to: undefined });
    expect(JSON.stringify(res.body)).not.toMatch(/Foreigner|Foreign Leaver|Foreign Doc|EMP999940/);
  });

  it.each(paths)('%s: no salary, ID number, bank, contact, file link or note', async (path, q) => {
    expectNoSecrets(await get(path, q));
  });
});

// ── Headcount ─────────────────────────────────────────────────────────────────
describe('headcount', () => {
  it('lists the current workforce — not exited, not soft-deleted — in the declared columns', async () => {
    const res = await get('/headcount');
    expect(res.body.columns).toEqual(WORKFORCE_EXPORT_COLUMNS.headcount);
    expect(col(res, 'Emp Code').sort()).toEqual(['EMP99993901', 'EMP99993902', 'EMP99993903']);
    expect(res.body.total).toBe(3);
  });

  it('labels blanks "Not recorded" and gives location by branch name', async () => {
    const res = await get('/headcount');
    const byCode = Object.fromEntries(res.body.rows.map(r => [r[0], r]));
    const c = (code, name) => byCode[code][res.body.columns.indexOf(name)];
    expect(c('EMP99993902', 'Department')).toBe('Not recorded');
    expect(c('EMP99993901', 'Location')).toBe('ZZWX Depot');
    expect(c('EMP99993902', 'Status')).toBe('Probation');
    expect(c('EMP99993901', 'Joining Date')).toBe('2024-01-10');
  });

  it.each([
    [{ department: 'Ops' }, ['EMP99993901']],
    [{ department: 'Not recorded' }, ['EMP99993902']],
    [{ branch_id: 'BRANCH' }, ['EMP99993901']],
    [{ status: 'Probation' }, ['EMP99993902']],
    [{ designation: 'Driver', employment_type: 'Permanent' }, ['EMP99993901']],
  ])('applies the page filters %j', async (q, codes) => {
    const query = { ...q };
    if (query.branch_id === 'BRANCH') query.branch_id = String(branchId);
    const res = await get('/headcount', query);
    expect(col(res, 'Emp Code').sort()).toEqual(codes);
  });

  it('is "as of today": a period does not narrow it', async () => {
    const res = await get('/headcount', { period: 'mtd' });
    expect(res.body.total).toBe(3);
  });

  it('status=Exited lists the leavers', async () => {
    const res = await get('/headcount', { status: 'Exited' });
    expect(col(res, 'Emp Code').sort()).toEqual(['EMP99993911', 'EMP99993912', 'EMP99993913', 'EMP99993914']);
  });

  it('an empty result is 200 with no rows', async () => {
    const res = await get('/headcount', { department: 'Nobody Works Here' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rows: [], total: 0 });
  });

  it('an invalid filter is 400', async () => {
    expect((await get('/headcount', { status: 'Retired' })).status).toBe(400);
  });
});

// ── Attrition ─────────────────────────────────────────────────────────────────
describe('attrition', () => {
  let res;
  beforeAll(async () => { res = await get('/attrition', YEAR); });

  it('lists exits in the period plus undated exits; not exits outside it', async () => {
    expect(res.body.columns).toEqual(WORKFORCE_EXPORT_COLUMNS.attrition);
    expect(col(res, 'Emp Code').sort()).toEqual(['EMP99993911', 'EMP99993912', 'EMP99993913']);
    expect(res.body.period).toMatchObject({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('an unknown exit date stays "Unknown" — never the updated_at date', async () => {
    const row = res.body.rows.find(r => r[0] === 'EMP99993912');
    const c = (n) => row[res.body.columns.indexOf(n)];
    expect(c('Exit Date')).toBe('Unknown');
    expect(c('Exit Date Source')).toMatch(/^Unknown/);
    expect(c('Period')).toBe('Date unknown — not placed in any period');
    expect(c('Exit Reason')).toBe('Not recorded');
    expect(JSON.stringify(row)).not.toContain('2026-07-15');
    expect(res.body.dateUnknown).toBe(1);
  });

  it('says where each known date came from', async () => {
    const byCode = Object.fromEntries(res.body.rows.map(r => [r[0], r]));
    const c = (code, n) => byCode[code][res.body.columns.indexOf(n)];
    expect([c('EMP99993911', 'Exit Date'), c('EMP99993911', 'Exit Date Source'), c('EMP99993911', 'Exit Reason')])
      .toEqual(['2026-06-30', 'Exit date', 'Better offer']);
    expect([c('EMP99993913', 'Exit Date'), c('EMP99993913', 'Exit Date Source'), c('EMP99993913', 'Exit Reason')])
      .toEqual(['2026-08-10', 'Last working day (exit request)', 'Relocation']);
  });

  it('the period moves the dated exits only', async () => {
    const r = await get('/attrition', { from: '2026-08-01', to: '2026-08-31' });
    expect(col(r, 'Emp Code').sort()).toEqual(['EMP99993912', 'EMP99993913']);   // undated still listed
    const old = await get('/attrition', { from: '2025-01-01', to: '2025-01-31' });
    expect(col(old, 'Emp Code').sort()).toEqual(['EMP99993912', 'EMP99993914']);
  });

  it('applies the page filters', async () => {
    const r = await get('/attrition', { ...YEAR, department: 'Admin' });
    expect(col(r, 'Emp Code')).toEqual(['EMP99993913']);
  });

  it('an empty result is 200 with no rows', async () => {
    const r = await get('/attrition', { ...YEAR, department: 'Nobody Works Here' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ rows: [], total: 0, dateUnknown: 0 });
  });

  it.each([[{ from: '2026-13-01' }], [{ to: '31-12-2026' }]])('a malformed date %j is 400', async (q) => {
    expect((await get('/attrition', q)).status).toBe(400);
  });
});

// ── Document expiry ───────────────────────────────────────────────────────────
describe('document expiry', () => {
  it('requires an explicit window', async () => {
    const none = await get('/doc-expiry');
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/window must be one of/);
    expect((await get('/doc-expiry', { window: 'forever' })).status).toBe(400);
  });

  it.each([
    ['expired',       ['Aadhar Card 2345 6789 0123']],
    ['next30',        ['Passport']],
    ['next60',        ['Passport', 'Licence']],
    ['next90',        ['Passport', 'Licence']],
    ['expired_or_30', ['Aadhar Card 2345 6789 0123', 'Passport']],
  ])('window=%s lists exactly the documents inside it', async (window, names) => {
    const res = await get('/doc-expiry', { window });
    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual(WORKFORCE_EXPORT_COLUMNS.documents);
    expect(col(res, 'Document Name')).toEqual(names);
    expect(res.body.window.key).toBe(window);
  });

  it('excludes soft-deleted employees\' documents, other companies\' and mismatched-company documents', async () => {
    const res = await get('/doc-expiry', { window: 'expired' });
    expect(JSON.stringify(res.body)).not.toMatch(/Deleted Employee Doc|Mismatched Company Doc|Foreign Doc/);
  });

  it('reports days left and expired/expiring', async () => {
    const res = await get('/doc-expiry', { window: 'expired_or_30' });
    const byName = Object.fromEntries(res.body.rows.map(r => [r[res.body.columns.indexOf('Document Name')], r]));
    const c = (n, f) => byName[n][res.body.columns.indexOf(f)];
    expect([c('Aadhar Card 2345 6789 0123', 'Days Left'), c('Aadhar Card 2345 6789 0123', 'Expiry Status')]).toEqual([-1, 'Expired']);
    expect([c('Passport', 'Days Left'), c('Passport', 'Expiry Status'), c('Passport', 'Document Status')]).toEqual([20, 'Expiring', 'verified']);
  });

  it('applies the page filters to whose documents are listed', async () => {
    const res = await get('/doc-expiry', { window: 'next60', department: 'Admin' });
    expect(col(res, 'Document Name')).toEqual(['Licence']);
  });

  it('an empty result is 200 with no rows', async () => {
    const res = await get('/doc-expiry', { window: 'next30', department: 'Nobody Works Here' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rows: [], total: 0 });
  });
});
