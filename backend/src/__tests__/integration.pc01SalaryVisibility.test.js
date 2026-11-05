/**
 * PC-01 closure — salary visible only to payroll:view, written only with payroll:edit.
 *
 *   1. Employee APIs: GET /employees, /employees/:id, /employees/ex and the
 *      full-row responses (status / exit-details) carry `basic_salary` only for
 *      payroll:view holders and the employee themself. hr_exec — an HR_PII role
 *      maskPII returned in full — read every Basic before.
 *   2. PUT /employees/:id with a salary field needs payroll:edit.
 *   3. /attendance/analytics/overtime-cost withholds the cost columns (derived
 *      from Basic) without payroll:view, and refuses a login with no company.
 *   4. /ai/anomalies drops the named TDS-mismatch rows, and /ai/chat the payroll
 *      totals, without payroll:view.
 *
 * Real routers and database; two throwaway companies, synthetic employees.
 * No salary or payroll row is changed by a request here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }              = await import('../config/db.js');
const { verifyToken }                = await import('../middlewares/auth.middleware.js');
const { buildApp }                   = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { default: employeeRoutes }    = await import('../employees/employee.routes.js');
const { default: attendanceRoutes }  = await import('../modules/attendance/routes/attendance.routes.js');
const { default: aiRoutes }          = await import('../modules/intelligence/ai.routes.js');

const app = buildApp(
  ['/api/employees', employeeRoutes],
  ['/api/attendance', verifyToken, attendanceRoutes],
  ['/api/ai', verifyToken, aiRoutes],
);

const PREFIX = 'ZZPC01SV';
const NOCO_EMAIL = `${PREFIX.toLowerCase()}.noco@test.invalid`;
const now = new Date();
const CUR_M = now.getMonth() + 1, CUR_Y = now.getFullYear();
let co, other, noCo;
const U = {}, E = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  const q = (sql) => pool.query(sql, [companyId]);
  await q(`UPDATE users SET employee_id = NULL WHERE company_id = $1`);
  await q(`DELETE FROM attendance_ot_records WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_runs WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM employee_salary_assignments WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM exit_requests WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM employees WHERE company_id = $1`);
}

async function dropNoCompanyLogin() {
  const u = `(SELECT id FROM users WHERE email = $1)`;
  for (const t of ['audit_logs', 'access_denials', 'notifications']) {
    await pool.query(`DELETE FROM ${t} WHERE user_id IN ${u}`, [NOCO_EMAIL]).catch(() => {});
  }
  await pool.query(`DELETE FROM user_roles WHERE user_id IN ${u}`, [NOCO_EMAIL]);
  await pool.query(`DELETE FROM users WHERE email = $1`, [NOCO_EMAIL]);
}

async function addEmployee(company, code, fields = {}) {
  const f = { first_name: code, last_name: 'Sv', status: 'Active', joining_date: '2025-04-01', department: 'Assembly', basic_salary: 41000, ...fields };
  const cols = Object.keys(f);
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
    [company.companyId, code, ...cols.map(c => f[c])]);
  return r.id;
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  await dropNoCompanyLogin();
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  for (const role of ['hr', 'hr_exec', 'hr_manager', 'payroll_admin', 'finance_manager', 'manager', 'employee', 'store_keeper']) {
    U[role] = await addUser(pool, co, { label: `r_${role}`, roleCode: role });
  }
  E.A = await addEmployee(co, 'EMP001');
  E.SELF = await addEmployee(co, 'EMP002', { basic_salary: 23000 });
  E.LEFT = await addEmployee(co, 'EMP003', { status: 'Left', exit_date: '2026-06-30' });
  E.HREXEC = await addEmployee(co, 'EMP004');
  // The employee's link travels in the token, as the real login signs it.
  await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [E.SELF, U.employee.userId]);
  U.employee = { ...U.employee, token: () => jwt.sign({ userId: U.employee.userId, role: 'employee', company_id: co.companyId, employee_id: E.SELF }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
  await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [E.HREXEC, U.hr_exec.userId]);
  U.hr_exec = { ...U.hr_exec, token: () => jwt.sign({ userId: U.hr_exec.userId, role: 'hr_exec', company_id: co.companyId, employee_id: E.HREXEC }, process.env.JWT_SECRET, { expiresIn: '1h' }) };

  // One OT earner in the department: the cost would give their Basic back.
  await pool.query(
    `INSERT INTO attendance_ot_records (employee_id, attendance_date, ot_hours, multiplier, status, ot_type, company_id)
     VALUES ($1, make_date($2, $3, 2), 4, 1.5, 'approved', 'weekday', $4)`, [E.A, CUR_Y, CUR_M, co.companyId]);
  // A TDS mismatch this month: 1,000 deducted vs 36,000 / 12 = 3,000 computed.
  await pool.query(
    `INSERT INTO payroll_runs (employee_id, month, year, status, gross, net_pay, total_deductions, tds, annual_tax,
                               employee_pf, employer_pf, employee_esi, employer_esi, professional_tax, ctc_monthly, is_test)
     VALUES ($1, $2, $3, 'pending', 41000, 40000, 1000, 1000, 36000, 0, 0, 0, 0, 0, 41000, false)`, [E.A, CUR_M, CUR_Y]);

  const { rows: [nu] } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active, role)
     VALUES ('PC01 SV no-company hr', $1, 'not-a-real-hash', NULL, true, 'hr') RETURNING id`, [NOCO_EMAIL]);
  const { rows: [hrRole] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = 'hr' LIMIT 1`);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [nu.id, hrRole.id]);
  noCo = { token: () => jwt.sign({ userId: nu.id, role: 'hr', company_id: null, employee_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}, 60000);

afterAll(async () => {
  for (const c of [co, other]) {
    if (!c) continue;
    await sweep(c.companyId);
    await dropIsolatedCompany(pool, c.companyId);
  }
  await dropNoCompanyLogin();
});

describe('PC-01 Basic on the employee APIs', () => {
  it('hr_exec reads the record but not the Basic', async () => {
    const one = await call(U.hr_exec, 'get', `/api/employees/${E.A}`);
    expect(one.status).toBe(200);
    expect(one.body.office_id).toBe('EMP001');
    expect(one.body).not.toHaveProperty('basic_salary');
    const list = await call(U.hr_exec, 'get', '/api/employees');
    expect(list.status).toBe(200);
    const rows = Array.isArray(list.body) ? list.body : list.body.data;
    const a = rows.find(r => r.id === E.A);
    expect(a).toBeTruthy();
    expect(a).not.toHaveProperty('basic_salary');
    const ex = await call(U.hr_exec, 'get', '/api/employees/ex');
    expect(ex.status).toBe(200);
    const left = (Array.isArray(ex.body) ? ex.body : ex.body.data).find(r => r.id === E.LEFT);
    expect(left).toBeTruthy();
    expect(left).not.toHaveProperty('basic_salary');
  });

  it('hr_exec still sees their own Basic', async () => {
    const res = await call(U.hr_exec, 'get', `/api/employees/${E.HREXEC}`);
    expect(Number(res.body.basic_salary)).toBe(41000);
  });

  it('payroll:view holders read the Basic', async () => {
    for (const role of ['hr', 'hr_manager', 'payroll_admin', 'finance_manager']) {
      const res = await call(U[role], 'get', `/api/employees/${E.A}`);
      expect(res.status, role).toBe(200);
      expect(Number(res.body.basic_salary), role).toBe(41000);
    }
  });

  it('an employee reads their own Basic', async () => {
    const res = await call(U.employee, 'get', `/api/employees/${E.SELF}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.basic_salary)).toBe(23000);
  });

  it("a status change does not return the Basic to hr_exec", async () => {
    const res = await call(U.hr_exec, 'patch', `/api/employees/${E.A}/status`).send({ status: 'Active' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).not.toHaveProperty('basic_salary');
    const hr = await call(U.hr, 'patch', `/api/employees/${E.A}/status`).send({ status: 'Active' });
    expect(Number(hr.body.basic_salary)).toBe(41000);
  });
});

describe('PC-01 salary writes through Edit Employee', () => {
  it('hr_exec cannot correct the salary; nothing is written', async () => {
    const res = await call(U.hr_exec, 'put', `/api/employees/${E.A}`).send({ basic_salary: 99999 });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('SALARY_PERMISSION');
    const { rows: [e] } = await pool.query(`SELECT basic_salary FROM employees WHERE id = $1`, [E.A]);
    expect(Number(e.basic_salary)).toBe(41000);
    const { rows: [n] } = await pool.query(`SELECT COUNT(*)::int AS n FROM employee_salary_assignments WHERE employee_id = $1`, [E.A]);
    expect(n.n).toBe(0);
  });

  it('a salary_revision_id alone is refused as well', async () => {
    const res = await call(U.hr_exec, 'put', `/api/employees/${E.A}`).send({ salary_revision_id: 1, special_allowance: 1 });
    expect(res.status).toBe(403);
  });
});

describe('PC-01 overtime cost', () => {
  const path = `/api/attendance/analytics/overtime-cost?month=${CUR_M}&year=${CUR_Y}`;

  it('without payroll:view the cost columns are withheld, the hours are not', async () => {
    const res = await call(U.employee, 'get', path);
    expect(res.status).toBe(200);
    const row = res.body.find(r => r.department === 'Assembly');
    expect(Number(row.total_ot_hours)).toBe(4);
    expect(row).toMatchObject({ approved_ot_cost: null, total_ot_cost: null, cost_restricted: true });
  });

  it('a payroll:view holder gets the cost (= one Basic recoverable from it)', async () => {
    const res = await call(U.hr, 'get', path);
    const row = res.body.find(r => r.department === 'Assembly');
    // 4 h × 1.5 × 41,000 / 26 / 9 = 1,051
    expect(Number(row.approved_ot_cost)).toBe(1051);
    expect(row.cost_restricted).toBeUndefined();
  });

  it('a login with no company is refused (it used to read every tenant)', async () => {
    expect((await call(noCo, 'get', path)).status).toBe(403);
  });
});

describe('PC-01 AI payroll answers', () => {
  it('anomalies name a TDS mismatch to payroll:view only', async () => {
    const hr = await call(U.hr, 'get', '/api/ai/anomalies');
    expect(hr.status).toBe(200);
    expect(hr.body.data.some(a => a.type === 'TDS Mismatch' && a.affected_name)).toBe(true);
    const sk = await call(U.store_keeper, 'get', '/api/ai/anomalies');
    expect(sk.status).toBe(200);
    expect(sk.body.data.some(a => a.type === 'TDS Mismatch')).toBe(false);
  });

  it('chat answers payroll totals to payroll:view only', async () => {
    const sk = await call(U.store_keeper, 'post', '/api/ai/chat').send({ message: 'show payroll totals' });
    expect(sk.status).toBe(200);
    expect(sk.body.status).toBe('PERMISSION_REQUIRED');
    const hr = await call(U.hr, 'post', '/api/ai/chat').send({ message: 'show payroll totals' });
    expect(hr.body.status).not.toBe('PERMISSION_REQUIRED');
  });
});
