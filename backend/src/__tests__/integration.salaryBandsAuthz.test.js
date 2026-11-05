/**
 * Authorization on `GET /analytics/employee-reports/salary-bands`.
 *
 * analyticsPolicy gates `/analytics` by path prefix and requires `payroll:view`
 * for '/salary-bands'. A rule matches only at the START of the path, so the
 * nested copy at '/employee-reports/salary-bands' — same data: headcount and
 * avg/min/max basic salary per band and grade — matched no rule and fell through
 * to the router default, `hr:view`. Every HR role without payroll access could
 * read it. `hr_exec` is that role in the live matrix (hr:view yes, payroll:view no).
 *
 * The suite pins:
 *   · the hole is closed — hr:view alone is denied, and the denial carries no data;
 *   · the right users kept it — payroll:view is allowed, including `finance_manager`,
 *     which holds payroll:view but NOT hr:view (so this is the rule under test
 *     answering, not the hr:view default);
 *   · an allowed caller still sees only its own company's bands;
 *   · the class of bug — every salary-reading route in analytics.routes.js,
 *     found from the source, is denied to hr:view alone. The next nested copy of
 *     a salary query fails here instead of shipping on the default.
 *
 * Real role_permissions matrix, like integration.biometricAuthz.test.js: a mocked
 * permission answer would only be testing the mock.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// setup.js presets DB_PASSWORD to a placeholder; restore the real one before
// config/db.js builds its pool (hence the dynamic imports below).
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

const PATH = '/api/analytics/employee-reports/salary-bands';

/**
 * requirePermission consults the user-level `permissions` table before the role
 * matrix, so the probe user must own no override row (checked in beforeAll) or
 * every assertion would measure the override instead of the role.
 */
const PROBE_USER_ID = -424243;

/** Mounted exactly as server.js mounts it: policy at the mount, then the router. */
function appAs(roles, companyId = 1) {
  const a = express();
  a.use((req, _res, next) => {
    if (roles) {
      req.user  = { userId: PROBE_USER_ID, id: PROBE_USER_ID, roles, role: roles[0], company_id: companyId };
      req.scope = { company_id: companyId };
    }
    next();
  });
  a.use('/api/analytics', analyticsPolicy, analyticsRoutes);
  return a;
}

/** A denial must not carry any part of the report. */
function expectNoSalaryData(res) {
  expect(res.body?.data).toBeUndefined();
  expect(res.body?.total).toBeUndefined();
  expect(JSON.stringify(res.body ?? {})).not.toMatch(/salary|headcount|band|grade/i);
}

/**
 * A second tenant with one salaried employee, so the scoping assertions have a
 * row that must NOT leak. 999930 follows the 9999xx fixed-tenant registry
 * (testTenantIds.contract.test.js); the company row is left in place like the
 * other registry tenants, the employee is removed by its captured id.
 */
const FOREIGN_COMPANY_ID = 999930;
const FOREIGN_BAND  = 'ZZSALB Foreign Band';
const FOREIGN_GRADE = 'ZZSALB-G';
const FOREIGN_BASIC = 987654;
let foreignEmployeeId = null;

beforeAll(async () => {
  const { rows: ov } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM permissions WHERE user_id = $1', [PROBE_USER_ID]);
  expect(ov[0].n, 'probe user must hold no user-level permission override').toBe(0);

  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1, 'ZZSALB Foreign Tenant', 'ZZSALB')
     ON CONFLICT (id) DO NOTHING`, [FOREIGN_COMPANY_ID]);
  // office_id must satisfy employees_office_id_format (^EMP[0-9]{3,}$); `name`
  // is GENERATED and cannot be inserted.
  const { rows } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, band, grade, basic_salary)
     VALUES ($1, 'EMP999930', 'ZZSALB', 'Foreign', 'Active', $2, $3, $4) RETURNING id`,
    [FOREIGN_COMPANY_ID, FOREIGN_BAND, FOREIGN_GRADE, FOREIGN_BASIC]);
  foreignEmployeeId = rows[0].id;
});

afterAll(async () => {
  // Exact captured id — never an inferred `WHERE company_id = …`.
  if (foreignEmployeeId != null) {
    await pool.query('DELETE FROM employees WHERE id = $1', [foreignEmployeeId]);
  }
});

describe('the hole: hr:view alone read salary bands', () => {
  it('hr_exec (hr:view, no payroll:view) is denied with no data', async () => {
    const res = await request(appAs(['hr_exec'])).get(PATH);
    expect(res.status).toBe(403);
    expectNoSalaryData(res);
  });

  it('employee (neither permission) is denied with no data', async () => {
    const res = await request(appAs(['employee'])).get(PATH);
    expect(res.status).toBe(403);
    expectNoSalaryData(res);
  });

  it('an unauthenticated caller is refused with no data', async () => {
    const res = await request(appAs(null)).get(PATH);
    expect(res.status).toBe(401);
    expectNoSalaryData(res);
  });

  it('the xlsx export is denied too', async () => {
    const res = await request(appAs(['hr_exec'])).get(`${PATH}?format=xlsx`);
    expect(res.status).toBe(403);
    expect(res.headers['content-type'] || '').not.toMatch(/spreadsheetml/);
  });
});

describe('payroll:view keeps access, within its own company', () => {
  it('finance_manager (payroll:view, NO hr:view) is allowed — the payroll rule answers, not the hr default', async () => {
    const res = await request(appAs(['finance_manager'])).get(PATH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('payroll_admin is allowed', async () => {
    const res = await request(appAs(['payroll_admin'])).get(PATH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('company 1 does not see the foreign tenant\'s band', async () => {
    const res = await request(appAs(['payroll_admin'], 1)).get(PATH);
    expect(res.status).toBe(200);
    expect(res.body.data.map(r => r.Band)).not.toContain(FOREIGN_BAND);
    expect(res.body.data.map(r => Number(r['Max Salary']))).not.toContain(FOREIGN_BASIC);
  });

  it('the foreign tenant sees exactly its own band and nothing of company 1', async () => {
    const res = await request(appAs(['payroll_admin'], FOREIGN_COMPANY_ID)).get(PATH);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const [row] = res.body.data;
    expect(row.Band).toBe(FOREIGN_BAND);
    expect(row.Grade).toBe(FOREIGN_GRADE);
    expect(Number(row.Headcount)).toBe(1);
    expect(Number(row['Max Salary'])).toBe(FOREIGN_BASIC);
  });
});

/**
 * Every route in analytics.routes.js whose handler mentions salary, found from
 * the source rather than listed by hand — a hand list is what missed the nested
 * copy. Comments are stripped so prose about salary does not count.
 */
function salaryRoutesFromSource() {
  const src = readFileSync(resolve(here, '../analytics/routes/analytics.routes.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const starts = [...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)]
    .map(m => ({ at: m.index, method: m[1], path: m[2] }));
  return starts
    .filter((r, i) => /salary/i.test(src.slice(r.at, starts[i + 1]?.at ?? src.length)))
    .map(r => ({ method: r.method, path: r.path }));
}

describe('every salary-reading analytics route needs payroll:view', () => {
  const routes = salaryRoutesFromSource();

  it('finds the salary routes it is guarding (not vacuous)', () => {
    const paths = routes.map(r => r.path);
    expect(paths).toEqual(expect.arrayContaining(
      ['/salary-bands', '/employee-reports/salary-bands', '/hr-benchmarks']));
  });

  it('denies each one to hr:view alone', async () => {
    const open = [];
    for (const { method, path } of routes) {
      const res = await request(appAs(['hr_exec']))[method](`/api/analytics${path}`);
      if (res.status !== 403) open.push(`${method.toUpperCase()} ${path} → ${res.status}`);
    }
    expect(open, `salary routes reachable with hr:view alone:\n  ${open.join('\n  ')}`).toEqual([]);
  });
});
