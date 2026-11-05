/**
 * PC-01 closure decisions (04 Nov 26) — manual §231.
 *
 *   1. salary_proposals:approve — admin, super_admin, finance_manager only
 *      (migration 20261104000002 removed hr_manager and payroll_admin)
 *   2. company-wide increments (list, one row, budget) — performance:approve or
 *      payroll:edit; finance_manager (payroll:view only) no longer
 *   3. leave encashment — a claim for yourself, or payroll:edit; amounts are
 *      computed, never sent; money fields only to payroll:view or the claimant
 *   4. anomaly cron — one company at a time; a named TDS mismatch only to that
 *      company's payroll:view holders
 *   5. Add Employee — a salary value needs payroll:edit; without it the employee
 *      is still created when no salary is sent
 *
 * Real routers and database; two throwaway companies, synthetic employees.
 * No existing salary assignment or payroll record is touched; no payroll is
 * generated, approved or paid.
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

const { default: pool }             = await import('../config/db.js');
const { verifyToken }               = await import('../middlewares/auth.middleware.js');
const { buildApp }                  = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { default: salaryRoutes }     = await import('../modules/payroll/salaryStructure.routes.js');
const { default: incrementRoutes }  = await import('../modules/performance/routes/increments.routes.js');
const { default: encashmentRoutes } = await import('../modules/leaves/routes/encashment.routes.js');
const { default: employeeRoutes }   = await import('../employees/employee.routes.js');
const { runAnomalyDetectionCheck }  = await import('../jobs/anomalyDetection.cron.js');

const app = buildApp(
  ['/api/salary-structures', verifyToken, salaryRoutes],
  ['/api/performance/increments', verifyToken, incrementRoutes],
  ['/api/leave-encashment', verifyToken, encashmentRoutes],
  ['/api/employees', employeeRoutes],
);

const PREFIX = 'ZZPC01CD';
const now = new Date();
const CUR_M = now.getMonth() + 1, CUR_Y = now.getFullYear();
let co, other, dept, desig, leaveTypeId;
const U = {}, B = {}, E = {}, R = {}, RUN = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);
const linked = (u, employeeId, role, company) => ({ ...u, token: () => jwt.sign({ userId: u.userId, role, company_id: company.companyId, employee_id: employeeId }, process.env.JWT_SECRET, { expiresIn: '1h' }) });

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  const users = `(SELECT id FROM users WHERE company_id = $1)`;
  const q = (sql) => pool.query(sql, [companyId]);
  const soft = (sql) => q(sql).catch(() => {});
  await q(`UPDATE users SET employee_id = NULL WHERE company_id = $1`);
  await q(`DELETE FROM permissions WHERE user_id IN ${users}`);
  await soft(`DELETE FROM password_reset_otps WHERE user_id IN ${users}`);
  await soft(`DELETE FROM audit_logs WHERE module_name = 'intelligence' AND reference_id IN (SELECT id::text FROM payroll_runs WHERE employee_id IN ${emps})`);
  await q(`DELETE FROM employee_bank_change_requests WHERE company_id = $1`);
  await q(`DELETE FROM leave_encashments WHERE company_id = $1 OR employee_id IN ${emps}`);
  await q(`DELETE FROM increment_recommendations WHERE company_id = $1 OR employee_id IN ${emps}`);
  await q(`DELETE FROM salary_revision_proposals WHERE company_id = $1`);
  await q(`DELETE FROM payroll_runs WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM employee_salary_assignments WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM employees WHERE company_id = $1`);
  await q(`DELETE FROM leave_types WHERE company_id = $1`);
}

async function addEmployee(company, code, fields = {}) {
  const f = { first_name: code, last_name: 'Cd', status: 'Active', joining_date: '2025-04-01', basic_salary: 26000, ...fields };
  const cols = Object.keys(f);
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
    [company.companyId, code, ...cols.map(c => f[c])]);
  return r.id;
}

const payrollOverride = (user, flags) => pool.query(
  `INSERT INTO permissions (user_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
   VALUES ($1, 'payroll', $2, false, false, false, false, false)`, [user.userId, flags.view]);

async function tdsMismatchRun(employeeId) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO payroll_runs (employee_id, month, year, status, gross, net_pay, total_deductions, tds, annual_tax,
                               employee_pf, employer_pf, employee_esi, employer_esi, professional_tax, ctc_monthly, is_test)
     VALUES ($1, $2, $3, 'pending', 26000, 25000, 1000, 1000, 36000, 0, 0, 0, 0, 0, 26000, false) RETURNING id`, [employeeId, CUR_M, CUR_Y]);
  return r.id;
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  ({ rows: [{ name: dept }] } = await pool.query(`SELECT name FROM master_departments  WHERE is_active ORDER BY id LIMIT 1`));
  ({ rows: [{ name: desig }] } = await pool.query(`SELECT name FROM master_designations WHERE is_active ORDER BY id LIMIT 1`));

  for (const role of ['super_admin', 'payroll_admin', 'hr_manager', 'finance_manager', 'hr', 'hr_exec', 'manager', 'employee', 'finance', 'accounts_exec']) {
    U[role] = await addUser(pool, co, { label: `r_${role}`, roleCode: role });
  }
  // hr whose payroll row is view-only (no edit): may create employees, not salaries
  U.hrNoPayEdit = await addUser(pool, co, { label: 'hrnopayedit', roleCode: 'hr' });
  await payrollOverride(U.hrNoPayEdit, { view: true });
  // hr whose payroll row is all-false: holds the role, not the grant
  U.hrDenied = await addUser(pool, co, { label: 'hrdenied', roleCode: 'hr' });
  await payrollOverride(U.hrDenied, { view: false });

  E.MGR  = await addEmployee(co, 'EMP001');
  E.SELF = await addEmployee(co, 'EMP002', { reporting_manager_id: E.MGR });
  E.COL  = await addEmployee(co, 'EMP003', { reporting_manager_id: E.MGR });
  E.EXEC = await addEmployee(co, 'EMP004');
  E.OTHER = await addEmployee(other, 'EMP001');
  await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [E.SELF, U.employee.userId]);
  await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [E.MGR, U.manager.userId]);
  await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [E.EXEC, U.hr_exec.userId]);
  U.employee = linked(U.employee, E.SELF, 'employee', co);
  U.manager = linked(U.manager, E.MGR, 'manager', co);
  U.hr_exec = linked(U.hr_exec, E.EXEC, 'hr_exec', co);

  B.hr = await addUser(pool, other, { label: 'hr', roleCode: 'hr' });
  B.payroll_admin = await addUser(pool, other, { label: 'payroll_admin', roleCode: 'payroll_admin' });
  B.finance_manager = await addUser(pool, other, { label: 'finance_manager', roleCode: 'finance_manager' });

  const { rows: [lt] } = await pool.query(
    `INSERT INTO leave_types (leave_name, leave_code, annual_quota, is_encashable, company_id)
     VALUES ('PC01 Encashable', 'PC01EL', 12, true, $1) RETURNING id`, [co.companyId]);
  leaveTypeId = lt.id;

  R.SELF = (await pool.query(
    `INSERT INTO increment_recommendations (company_id, employee_id, current_ctc, recommended_increment_pct, recommended_new_ctc, status)
     VALUES ($1, $2, 300000, 10, 330000, 'submitted') RETURNING id`, [co.companyId, E.SELF])).rows[0].id;
  R.EXEC = (await pool.query(
    `INSERT INTO increment_recommendations (company_id, employee_id, current_ctc, recommended_increment_pct, recommended_new_ctc, status)
     VALUES ($1, $2, 400000, 8, 432000, 'submitted') RETURNING id`, [co.companyId, E.EXEC])).rows[0].id;

  RUN.A = await tdsMismatchRun(E.COL);
  RUN.B = await tdsMismatchRun(E.OTHER);
}, 90000);

afterAll(async () => {
  for (const c of [co, other]) {
    if (!c) continue;
    await sweep(c.companyId);
    await dropIsolatedCompany(pool, c.companyId);
  }
});

// ── 1. Salary proposal approval ─────────────────────────────────────────────
describe('decision 1 — salary proposals are approved by Finance and the administrators', () => {
  const approve = (who) => call(who, 'post', '/api/salary-structures/proposals/2147483000/approve').send({});

  it('the matrix holds approve for super_admin, admin, finance_manager only', async () => {
    const { rows } = await pool.query(
      `SELECT LOWER(r.code) AS code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE rp.module = 'salary_proposals' AND rp.can_approve ORDER BY 1`);
    expect(rows.map(r => r.code)).toEqual(['admin', 'finance_manager', 'super_admin']);
  });

  it('hr_manager and payroll_admin are refused at the gate', async () => {
    for (const role of ['hr_manager', 'payroll_admin', 'hr']) {
      const res = await approve(U[role]);
      expect(res.status, role).toBe(403);
      expect(res.body.code, role).toBe('PERMISSION_DENIED');
    }
    expect((await call(U.payroll_admin, 'post', '/api/salary-structures/proposals/2147483000/reject').send({})).status).toBe(403);
  });

  it('finance_manager, admin and super_admin pass the gate (an unknown proposal is then not found)', async () => {
    for (const who of [U.finance_manager, co, U.super_admin]) {
      const res = await approve(who);
      expect(res.status, JSON.stringify(res.body)).not.toBe(403);
      expect(res.status).toBeLessThan(500);
    }
  });
});

// ── 2. Company-wide increments ──────────────────────────────────────────────
describe('decision 2 — finance_manager has no company-wide increment view', () => {
  const ids = (b) => b.map(r => Number(r.id)).sort((x, y) => x - y);

  it('finance_manager is refused the list, a row and the budget', async () => {
    expect((await call(U.finance_manager, 'get', '/api/performance/increments/recommendations')).status).toBe(403);
    expect((await call(U.finance_manager, 'get', `/api/performance/increments/recommendations/${R.SELF}`)).status).toBe(403);
    expect((await call(U.finance_manager, 'get', '/api/performance/increments/budget-summary')).status).toBe(403);
  });

  it('payroll_admin, hr_manager (payroll:edit) and hr (performance:approve) keep the company-wide view', async () => {
    for (const role of ['payroll_admin', 'hr_manager', 'hr']) {
      const list = await call(U[role], 'get', '/api/performance/increments/recommendations');
      expect(list.status, role).toBe(200);
      expect(ids(list.body), role).toEqual([R.SELF, R.EXEC].sort((x, y) => x - y));
      expect((await call(U[role], 'get', '/api/performance/increments/budget-summary')).status, role).toBe(200);
    }
  });

  it('a line manager still sees direct reports only', async () => {
    const res = await call(U.manager, 'get', '/api/performance/increments/recommendations');
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([R.SELF]);
  });

  it("another company's payroll_admin sees none of them", async () => {
    const list = await call(B.payroll_admin, 'get', '/api/performance/increments/recommendations');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
    expect((await call(B.payroll_admin, 'get', `/api/performance/increments/recommendations/${R.SELF}`)).status).toBe(404);
  });
});

// ── 3. Leave encashment ─────────────────────────────────────────────────────
describe('decision 3 — leave encashment claims and their amounts', () => {
  const claim = (who, body) => call(who, 'post', '/api/leave-encashment').send({ leave_type_id: leaveTypeId, days_encashed: 2, year: CUR_Y, ...body });
  const count = async (employeeId) => (await pool.query(`SELECT COUNT(*)::int AS n FROM leave_encashments WHERE employee_id = $1`, [employeeId])).rows[0].n;
  const MONEY = ['rate_per_day', 'gross_amount', 'tds_amount', 'net_amount'];

  it('an employee cannot create a claim for a colleague; nothing is written', async () => {
    const res = await claim(U.employee, { employee_id: E.COL });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('ENCASHMENT_FOR_OTHERS');
    expect(res.body).not.toHaveProperty('rate_per_day');
    expect(await count(E.COL)).toBe(0);
  });

  it('hr_exec and a manager (no payroll:edit) cannot claim for someone else either', async () => {
    expect((await claim(U.hr_exec, { employee_id: E.COL })).status).toBe(403);
    expect((await claim(U.manager, { employee_id: E.COL })).status).toBe(403);
    expect(await count(E.COL)).toBe(0);
  });

  it('a request carrying an amount is refused, not silently recomputed', async () => {
    const res = await claim(U.employee, { employee_id: E.SELF, rate_per_day: 99999 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ENCASHMENT_AMOUNT_COMPUTED');
    expect(await count(E.SELF)).toBe(0);
  });

  it('only Payroll sets the TDS rate', async () => {
    const res = await claim(U.employee, { employee_id: E.SELF, tds_rate: 0 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ENCASHMENT_TDS_RATE');
    expect(await count(E.SELF)).toBe(0);
  });

  it('an employee claims for themself and sees their own amounts', async () => {
    const res = await claim(U.employee, { employee_id: E.SELF });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Number(res.body.rate_per_day)).toBe(1000);      // 26,000 / 26
    expect(Number(res.body.gross_amount)).toBe(2000);
  });

  it('a payroll:edit holder (hr) claims for an employee and sees the amounts', async () => {
    const res = await claim(U.hr, { employee_id: E.COL, tds_rate: 0.05 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Number(res.body.tds_amount)).toBe(100);
  });

  it('money fields go to payroll:view holders and the claimant only', async () => {
    const byId = (body) => Object.fromEntries(body.map(r => [r.employee_id, r]));
    const exec = byId((await call(U.hr_exec, 'get', '/api/leave-encashment')).body);
    for (const id of [E.SELF, E.COL]) for (const k of MONEY) expect(exec[id], `hr_exec ${k}`).not.toHaveProperty(k);
    expect(exec[E.COL].days_encashed).toBeDefined();
    const mgr = byId((await call(U.manager, 'get', '/api/leave-encashment')).body);
    expect(Object.keys(mgr).map(Number).sort()).toEqual([E.SELF, E.COL].sort());
    for (const k of MONEY) expect(mgr[E.COL]).not.toHaveProperty(k);
    const own = (await call(U.employee, 'get', '/api/leave-encashment')).body;
    expect(own.map(r => r.employee_id)).toEqual([E.SELF]);
    expect(Number(own[0].rate_per_day)).toBe(1000);
    const hr = byId((await call(U.hr, 'get', '/api/leave-encashment')).body);
    expect(Number(hr[E.COL].rate_per_day)).toBe(1000);
  });

  it('another company can neither claim for these employees nor list their claims', async () => {
    const res = await call(B.hr, 'post', '/api/leave-encashment').send({ employee_id: E.SELF, leave_type_id: leaveTypeId, days_encashed: 1 });
    expect(res.status).toBe(404);
    expect((await call(B.hr, 'get', '/api/leave-encashment')).body).toEqual([]);
    expect(await count(E.SELF)).toBe(1);
  });
});

// ── 4. Anomaly cron ─────────────────────────────────────────────────────────
describe('decision 4 — anomaly alerts per company, TDS mismatch to payroll:view only', () => {
  let got;
  beforeAll(async () => {
    await runAnomalyDetectionCheck({ companyIds: [co.companyId, other.companyId] });
    const { rows } = await pool.query(
      `SELECT user_id, reference_id::text AS ref FROM notifications
        WHERE notification_type = 'tds_mismatch' AND reference_id::text = ANY($1)`, [[String(RUN.A), String(RUN.B)]]);
    got = (ref) => rows.filter(r => r.ref === String(ref)).map(r => Number(r.user_id)).sort((x, y) => x - y);
  }, 60000);

  it("company A's mismatch goes to A's payroll:view holders — and nobody else", async () => {
    const expected = [co.adminId, U.super_admin.userId, U.payroll_admin.userId, U.hr_manager.userId,
      U.finance_manager.userId, U.hr.userId, U.hrNoPayEdit.userId].sort((x, y) => x - y);
    expect(got(RUN.A)).toEqual(expected);
  });

  it('holders of the role but not the grant get nothing (finance, accounts_exec, hr_exec, a deny override)', async () => {
    for (const u of [U.finance, U.accounts_exec, U.hr_exec, U.employee, U.manager, U.hrDenied]) {
      expect(got(RUN.A)).not.toContain(u.userId);
    }
  });

  it("company B's users never see A's mismatch, and B's goes to B's payroll users only", async () => {
    for (const u of [B.hr, B.payroll_admin, B.finance_manager, other]) expect(got(RUN.A)).not.toContain(u.userId ?? u.adminId);
    expect(got(RUN.B)).toEqual([other.adminId, B.hr.userId, B.payroll_admin.userId, B.finance_manager.userId].sort((x, y) => x - y));
  });
});

// ── 5. Add Employee without payroll:edit ────────────────────────────────────
describe('decision 5 — the first salary needs payroll:edit', () => {
  let seq = 0;
  const hire = (who, extra = {}) => {
    seq += 1;
    return call(who, 'post', '/api/employees').send({
      first_name: 'ZZPC01CD', last_name: `Hire${seq}`, company_email: `zzpc01cd.${Date.now()}.${seq}@example.com`,
      department: dept, designation: desig, status: 'Active', joining_date: '2026-06-01',
      account_number: '123456789012', ifsc_code: 'HDFC0001234', current_address: '1 Fixture Street', ...extra,
    });
  };
  const employeesNow = async () => (await pool.query(`SELECT COUNT(*)::int AS n FROM employees WHERE company_id = $1`, [co.companyId])).rows[0].n;

  it('without payroll:edit a salary is refused and nothing is created', async () => {
    const before = await employeesNow();
    for (const extra of [{ basic_salary: 30000 }, { special_allowance: '5000' }, { basic_salary: '30000', special_allowance: '' }]) {
      const res = await hire(U.hrNoPayEdit, extra);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.code).toBe('SALARY_PERMISSION');
    }
    expect(await employeesNow()).toBe(before);
  });

  it('without payroll:edit the employee is created when no salary is sent (blank fields are no value)', async () => {
    const res = await hire(U.hrNoPayEdit, { basic_salary: '', special_allowance: '' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM employee_salary_assignments WHERE employee_id = $1`, [res.body.id]);
    expect(rows[0].n).toBe(0);
    const { rows: [e] } = await pool.query(`SELECT basic_salary FROM employees WHERE id = $1`, [res.body.id]);
    expect(e.basic_salary == null || Number(e.basic_salary) === 0).toBe(true);
  });

  it('a payroll:edit holder (hr) sets the first salary', async () => {
    const res = await hire(U.hr, { basic_salary: 30000 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { rows } = await pool.query(`SELECT basic_salary FROM employee_salary_assignments WHERE employee_id = $1`, [res.body.id]);
    expect(rows.map(r => Number(r.basic_salary))).toEqual([30000]);
  });

  it('a salary correction on Edit Employee is refused without payroll:edit', async () => {
    const res = await call(U.hrNoPayEdit, 'put', `/api/employees/${E.COL}`).send({ basic_salary: 99999 });
    expect(res.status).toBe(403);
    const { rows: [e] } = await pool.query(`SELECT basic_salary FROM employees WHERE id = $1`, [E.COL]);
    expect(Number(e.basic_salary)).toBe(26000);
  });
});
