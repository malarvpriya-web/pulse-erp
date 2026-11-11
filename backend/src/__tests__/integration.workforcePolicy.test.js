/**
 * Workforce settings and the date-of-birth rule — real database (2026-11-10).
 *
 * Covered:
 *   · GET/PUT /api/analytics/workforce-settings — defaults, hr:edit to save,
 *     validation (nothing written on a 400), merge (other 'hr' keys survive),
 *     no company → 403
 *   · GET /api/analytics/workforce — the company's age limits decide which
 *     dates of birth are ages; the rest are listed in dataIssues.implausibleDob;
 *     minSample is the company's
 *   · updateEmployee — an UNCHANGED bad DOB never blocks an edit (EMP003 must
 *     stay editable); a changed DOB must be plausible
 *   · addEmployee — a bad DOB is refused
 *   · legacy /employee-reports/* — a non-super-admin with no company is 403,
 *     not "every company"
 *
 * Tenant 999998 belongs to this suite alone (testTenantIds registry).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }            = await import('../config/db.js');
const { analyticsPolicy }          = await import('../shared/analyticsAuthz.js');
const { default: analyticsRoutes } = await import('../analytics/routes/analytics.routes.js');
const { updateEmployee, addEmployee } = await import('../employees/employee.service.js');
const { localTodayIso } = await import('../shared/workforcePolicy.js');

const CO = 999998;
const PROBE_USER_ID = -424298;
const SETTINGS = '/api/analytics/workforce-settings';
const ids = [];

function appAs(roles, scope = { company_id: CO }) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user  = { userId: PROBE_USER_ID, id: PROBE_USER_ID, roles, role: roles[0], company_id: scope?.company_id ?? null };
    req.scope = scope;
    next();
  });
  a.use('/api/analytics', analyticsPolicy, analyticsRoutes);
  return a;
}

/** YYYY-MM-DD, `years` before today (local business date). */
const yearsAgo = (years, days = 0) => {
  const [y, m, d] = localTodayIso().split('-').map(Number);
  const dt = new Date(Date.UTC(y - years, m - 1, d - days));
  return dt.toISOString().slice(0, 10);
};

async function insertEmployee(office_id, fields) {
  const cols = ['company_id', 'office_id', 'first_name', 'last_name', ...Object.keys(fields)];
  const vals = [CO, office_id, 'ZZWP', 'Fixture', ...Object.values(fields)];
  const { rows } = await pool.query(
    `INSERT INTO employees (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, vals);
  ids.push(rows[0].id);
  return rows[0].id;
}
const settingsRow = async () => (await pool.query(
  `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'hr'`, [CO])).rows[0]?.settings ?? null;

let bad;      // 8 months old — the EMP003 shape
let future;   // born next month
let good;     // 30 years old

beforeAll(async () => {
  const { rows: ov } = await pool.query('SELECT COUNT(*)::int AS n FROM permissions WHERE user_id = $1', [PROBE_USER_ID]);
  expect(ov[0].n).toBe(0);
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1, 'ZZWP Workforce Policy Fixture', 'ZZWP')
                    ON CONFLICT (id) DO NOTHING`, [CO]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [CO]);
  await pool.query(`DELETE FROM company_settings WHERE company_id = $1`, [CO]);

  bad    = await insertEmployee('EMP99999801', { status: 'Active', dob: yearsAgo(0, 250), joining_date: '2026-02-25', phone: '9000000001' });
  future = await insertEmployee('EMP99999802', { status: 'Active', dob: yearsAgo(0, -30), joining_date: '2026-03-01' });
  good   = await insertEmployee('EMP99999803', { status: 'Active', dob: yearsAgo(30, 10), joining_date: '2026-03-01' });
});

afterAll(async () => {
  if (ids.length) await pool.query(`DELETE FROM employees WHERE id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [CO]);
  await pool.query(`DELETE FROM company_settings WHERE company_id = $1`, [CO]);
  // The shared pool is never closed by a test (sharedPoolLifecycle.contract).
});

describe('workforce settings endpoint', () => {
  it('a company that saved nothing gets the defaults, each marked default', async () => {
    const res = await request(appAs(['payroll_admin'])).get(SETTINGS);
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ min_employee_age: 18, max_employee_age: 80, analytics_min_sample: 5 });
    expect(Object.values(res.body.settings.is_default).every(Boolean)).toBe(true);
  });

  it('hr:view alone cannot save (payroll_admin)', async () => {
    const res = await request(appAs(['payroll_admin'])).put(SETTINGS).send({ min_employee_age: 16 });
    expect(res.status).toBe(403);
    expect(await settingsRow()).toBeNull();
  });

  it('an invalid value is a 400 listing the problem, and nothing is written', async () => {
    const res = await request(appAs(['hr_exec'])).put(SETTINGS).send({ min_employee_age: 10, analytics_min_sample: 3 });
    expect(res.status).toBe(400);
    expect(res.body.errors.join(' ')).toMatch(/14 to 25/);
    expect(await settingsRow()).toBeNull();
  });

  it('hr:edit saves; other hr keys in the same row survive', async () => {
    await pool.query(`INSERT INTO company_settings (company_id, module, settings) VALUES ($1, 'hr', '{"other_key": "keep"}')`, [CO]);
    const res = await request(appAs(['hr_exec'])).put(SETTINGS).send({ min_employee_age: 16, analytics_min_sample: 2 });
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ min_employee_age: 16, analytics_min_sample: 2, max_employee_age: 80 });
    expect(res.body.settings.is_default).toMatchObject({ min_employee_age: false, max_employee_age: true });
    expect(await settingsRow()).toMatchObject({ other_key: 'keep', min_employee_age: 16, analytics_min_sample: 2 });
  });

  it('a user with no company cannot save (nowhere to save it)', async () => {
    const res = await request(appAs(['hr_exec'], null)).put(SETTINGS).send({ min_employee_age: 16 });
    expect(res.status).toBe(403);
  });
});

describe('Workforce Analytics uses the company\'s limits', () => {
  it('only plausible dates of birth are ages; the rest are listed by id', async () => {
    const res = await request(appAs(['hr_exec'])).get('/api/analytics/workforce').query({ period: 'all' });
    expect(res.status).toBe(200);
    const age = res.body.breakdowns.age;
    expect(age.total).toBe(3);
    expect(age.recorded).toBe(1);
    expect(age.buckets.find(b => b.value === '30-34').count).toBe(1);
    expect(age.buckets.find(b => b.value === 'Under 25').count).toBe(0);
    expect(res.body.dataIssues.implausibleDob).toMatchObject({ count: 2, minAge: 16, maxAge: 80 });
    expect(res.body.dataIssues.implausibleDob.ids.sort()).toEqual([bad, future].sort());
    expect(res.body.minSample).toBe(2);   // the saved setting, not the constant 5
    const chip = res.body.completeness.find(f => f.field === 'age');
    expect(chip).toMatchObject({ recorded: 1, total: 3 });
  });
});

describe('date of birth on Edit Employee', () => {
  it('an UNCHANGED bad date of birth does not block saving another field', async () => {
    const { rows: [cur] } = await pool.query(`SELECT TO_CHAR(dob,'YYYY-MM-DD') AS dob FROM employees WHERE id = $1`, [bad]);
    await updateEmployee(bad, { dob: cur.dob, phone: '9000000099' }, CO);
    const { rows: [after] } = await pool.query(`SELECT phone FROM employees WHERE id = $1`, [bad]);
    expect(after.phone).toBe('9000000099');
  });

  it('changing it to another implausible date is refused with the company limit named', async () => {
    await expect(updateEmployee(bad, { dob: yearsAgo(5) }, CO)).rejects.toThrow(/company minimum is 16/);
  });

  it('correcting it to a plausible date is accepted', async () => {
    const fixed = yearsAgo(28);
    await updateEmployee(bad, { dob: fixed }, CO);
    const { rows: [after] } = await pool.query(`SELECT TO_CHAR(dob,'YYYY-MM-DD') AS dob FROM employees WHERE id = $1`, [bad]);
    expect(after.dob).toBe(fixed);
  });

  it('clearing it stays allowed (date of birth is optional)', async () => {
    await updateEmployee(good, { dob: '' }, CO);
    const { rows: [after] } = await pool.query(`SELECT dob FROM employees WHERE id = $1`, [good]);
    expect(after.dob).toBeNull();
  });
});

describe('date of birth on Add Employee', () => {
  it('a new hire born 8 months ago is refused before anything is written', async () => {
    await expect(addEmployee({
      company_id: CO, first_name: 'ZZWP', last_name: 'New', company_email: 'zzwp.new@example.invalid',
      department: 'Ops', designation: 'Driver', status: 'Active', joining_date: '2026-03-01',
      dob: yearsAgo(0, 240),
    })).rejects.toThrow(/company minimum is 16/);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM employees WHERE company_email = 'zzwp.new@example.invalid'`);
    expect(rows[0].n).toBe(0);
  });
});

describe('legacy employee reports fail closed', () => {
  it.each([
    ['/api/analytics/employee-reports/onboarding-progress', ['hr_exec']],
    ['/api/analytics/employee-reports/pending-confirmations', ['hr_exec']],
    ['/api/analytics/employee-reports/salary-bands', ['payroll_admin']],
  ])('%s: a non-super-admin with no company is 403, not every company', async (path, roles) => {
    const res = await request(appAs(roles, null)).get(path);
    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  it('onboarding-progress still answers within a company', async () => {
    const res = await request(appAs(['hr_exec'])).get('/api/analytics/employee-reports/onboarding-progress');
    expect(res.status).toBe(200);
    expect(res.body.data.every(r => String(r['Emp Code']).startsWith('EMP999998'))).toBe(true);
  });
});

// ── Router-wide company scope (2026-11-10) ───────────────────────────────────
// Every GET on the analytics router and its two sub-routers, read from source
// so a route added later is covered without editing this list.
describe('analytics router fails closed without a company', () => {
  const SRC = (f) => readFileSync(resolve(here, `../analytics/routes/${f}`), 'utf8');
  const pathsIn = (src, prefix = '') => [...src.matchAll(/router\.get\(\s*['"]([^'"]+)['"]/g)]
    .map(m => prefix + m[1].replace(/:[A-Za-z_]+/g, '1'));
  const PATHS = [
    ...pathsIn(SRC('analytics.routes.js')),
    ...pathsIn(SRC('powerQuality.routes.js'), '/pq'),
    ...pathsIn(SRC('manufacturing.routes.js'), '/manufacturing'),
  ];

  it('finds the routes it guards (not vacuous)', () => {
    expect(PATHS.length).toBeGreaterThan(40);
    expect(PATHS).toEqual(expect.arrayContaining(['/headcount', '/attrition', '/workforce']));
  });

  it('a non-super-admin with no company gets 403 on every one, before any query', async () => {
    // super_admin roles would pass the permission layer; use a role that holds
    // every module the policy asks for so the SCOPE guard is what answers.
    const app = appAs(['admin'], null);
    const leaks = [];
    for (const p of PATHS) {
      const res = await request(app).get(`/api/analytics${p}`);
      if (res.status !== 403) leaks.push(`${p} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('a global super-admin scope still passes the guard', async () => {
    const res = await request(appAs(['super_admin'], { company_id: null, isGlobal: true })).get('/api/analytics/workforce');
    expect(res.status).toBe(200);
  });

  it('a user whose company is on the user record but not req.scope is scoped to that company', async () => {
    const a = express();
    a.use((req, _res, next) => {
      req.user = { userId: PROBE_USER_ID, id: PROBE_USER_ID, roles: ['hr_exec'], role: 'hr_exec', company_id: CO };
      req.scope = null;
      next();
    });
    a.use('/api/analytics', analyticsPolicy, analyticsRoutes);
    const res = await request(a).get('/api/analytics/workforce').query({ period: 'all' });
    expect(res.status).toBe(200);
    expect(res.body.population.total).toBe(3);   // this fixture company only
  });
});

// ── Audit trail for a settings change ────────────────────────────────────────
// Mounted with the same audit floor server.js puts on /analytics (asserted in
// integration.workforceRouteMount.test.js). audit_logs is append-only, so the
// row this writes stays; it is tagged with this suite's tenant.
describe('saving settings is audited with the before and after values', () => {
  it('writes one audit_logs row carrying the old and new limits', async () => {
    const { auditMutations } = await import('../middlewares/auditMutations.js');
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.user = { userId: PROBE_USER_ID, id: PROBE_USER_ID, roles: ['hr_exec'], role: 'hr_exec', company_id: CO };
      req.scope = { company_id: CO };
      next();
    });
    a.use('/api/analytics', analyticsPolicy, auditMutations('analytics', { recordType: 'workforce_settings' }), analyticsRoutes);

    const res = await request(a).put(SETTINGS).send({ max_employee_age: 75 });
    expect(res.status).toBe(200);

    let row;
    for (let i = 0; i < 40 && !row; i++) {
      ({ rows: [row] } = await pool.query(
        `SELECT old_data_json, new_data_json FROM audit_logs
          WHERE module_name = 'analytics' AND reference_type = 'workforce_settings'
            AND user_id = $1 AND company_id = $2
          ORDER BY id DESC LIMIT 1`, [PROBE_USER_ID, CO]));
      if (!row) await new Promise(r => setTimeout(r, 50));
    }
    expect(row, 'audit row written').toBeTruthy();
    const oldData = typeof row.old_data_json === 'string' ? JSON.parse(row.old_data_json) : row.old_data_json;
    const newData = typeof row.new_data_json === 'string' ? JSON.parse(row.new_data_json) : row.new_data_json;
    expect(oldData).toMatchObject({ max_employee_age: 80 });
    expect(newData.request).toMatchObject({ max_employee_age: 75 });
  });
});
