/**
 * PC-01 — Payroll backend access control (manual §229, migration
 * 20261104000001_payroll_access_control_permissions).
 *
 * Payroll, salary-structure, salary-revision, increment, statutory-settings and
 * Form 24Q routes are gated by the permission matrix instead of hard-coded role
 * lists. Covered here:
 *   1. role × endpoint allow / deny for every payroll-relevant role
 *   2. company isolation (another tenant's HR; a login with no company)
 *   3. increments: manager / department_head see and create for DIRECT REPORTS only
 *   4. push-to-payroll outside CTC mode is refused and writes nothing (D7 / Q6)
 *   5. mark-paid: finance_manager only, never the run's preparer (D2 / Q1)
 *   6. statutory payroll switches need payroll_statutory_config:edit (Q3)
 *   7. Form 24Q needs payroll_tds_extract:export, other TDS routes finance:view (D6 / Q4)
 *   8. employee self-service payslips, multi-role union, a user-level deny override
 *
 * "Allowed" probes are aimed at a validation or not-found answer, so nothing is
 * generated, approved, paid or changed. The mark-paid fixtures are built so no
 * code path — old or new — can pay a run: the draft run cannot be paid, and the
 * approved runs belong to employees with no bank account (the service refuses
 * those before it writes). Real routers and database; two throwaway companies,
 * synthetic employees only — all removed afterwards.
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

const { default: pool }            = await import('../config/db.js');
const { verifyToken }              = await import('../middlewares/auth.middleware.js');
const { buildApp }                 = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { default: payrollRoutes }   = await import('../modules/payroll/payroll.routes.js');
const { default: salaryRoutes }    = await import('../modules/payroll/salaryStructure.routes.js');
const { default: settingsRoutes }  = await import('../modules/admin/settings-status.routes.js');
const { default: incrementRoutes } = await import('../modules/performance/routes/increments.routes.js');
const { default: tdsRoutes }       = await import('../modules/finance/tds.routes.js');
const { default: employeeRoutes }  = await import('../employees/employee.routes.js');

const app = buildApp(
  ['/api/payroll', verifyToken, payrollRoutes],
  ['/api/salary-structures', verifyToken, salaryRoutes],
  ['/api/settings', verifyToken, settingsRoutes],
  ['/api/performance/increments', verifyToken, incrementRoutes],
  ['/api/tds', verifyToken, tdsRoutes],
  ['/api/employees', employeeRoutes],
);

const PREFIX = 'ZZPC01';
const NOCO_EMAIL = `${PREFIX.toLowerCase()}.noco@test.invalid`;
const M = 1, Y = 2030;            // fixture payroll period — far from any real run
const ROLES = ['super_admin', 'admin', 'payroll_admin', 'hr_manager', 'hr', 'hr_exec', 'manager',
  'department_head', 'finance_manager', 'finance', 'accounts_exec', 'employee'];

let co, other, noCo;
const U = {};      // role → login in `co`
const B = {};      // logins in `other`
const E = {};      // employees
const R = {};      // increment recommendations
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  const users = `(SELECT id FROM users WHERE company_id = $1)`;
  await pool.query(`UPDATE users SET employee_id = NULL WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM permissions WHERE user_id IN ${users}`, [companyId]);
  await pool.query(`DELETE FROM increment_recommendations WHERE company_id = $1 OR employee_id IN ${emps}`, [companyId]);
  await pool.query(`DELETE FROM salary_revision_proposals WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM payroll_arrears WHERE employee_id IN ${emps}`, [companyId]);
  await pool.query(`DELETE FROM payroll_runs WHERE employee_id IN ${emps}`, [companyId]);
  await pool.query(`DELETE FROM employee_salary_assignments WHERE employee_id IN ${emps}`, [companyId]);
  await pool.query(`DELETE FROM payroll_statutory_rules WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM company_settings WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM salary_structures WHERE company_id = $1`, [companyId]);
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
  const f = { first_name: code, last_name: 'Pc01', status: 'Active', joining_date: '2025-04-01', ...fields };
  const cols = Object.keys(f);
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
    [company.companyId, code, ...cols.map(c => f[c])]);
  return r.id;
}

const link = (user, employeeId) => pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [employeeId, user.userId]);

async function addRun(employeeId, status, generatedBy, approvedBy = null) {
  await pool.query(
    `INSERT INTO payroll_runs (employee_id, month, year, status, gross, net_pay, total_deductions, tds,
                               employee_pf, employer_pf, employee_esi, employer_esi, professional_tax, ctc_monthly, is_test, generated_by, approved_by)
     VALUES ($1, $2, $3, $4, 30000, 30000, 0, 0, 0, 0, 0, 0, 0, 30000, false, $5, $6)`, [employeeId, M, Y, status, generatedBy, approvedBy]);
}

async function addRecommendation(employeeId, status = 'submitted') {
  const { rows: [r] } = await pool.query(
    `INSERT INTO increment_recommendations (company_id, employee_id, current_ctc, recommended_increment_pct,
                                            recommended_new_ctc, effective_date, status)
     VALUES ($1, $2, 300000, 10, 330000, '2030-04-01', $3) RETURNING id`, [co.companyId, employeeId, status]);
  return r.id;
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  await dropNoCompanyLogin();
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  for (const role of ROLES) U[role] = await addUser(pool, co, { label: `r_${role}`, roleCode: role });

  // Org: manager → R1, department_head → R2, X reports to nobody under test.
  E.MGR  = await addEmployee(co, 'EMP001');
  E.DH   = await addEmployee(co, 'EMP002');
  E.R1   = await addEmployee(co, 'EMP003', { reporting_manager_id: E.MGR });
  E.R2   = await addEmployee(co, 'EMP004', { reporting_manager_id: E.DH });
  E.X    = await addEmployee(co, 'EMP005', { basic_salary: 20000 });
  E.SELF = await addEmployee(co, 'EMP006');
  // Mark-paid fixtures: PAYV has valid bank details (its run is a DRAFT, which
  // the service never pays); PAYI / PAYN have NO bank account, so the service
  // refuses them before writing even if an access check were missing.
  E.PAYV = await addEmployee(co, 'EMP007', { account_number: '123456789012', ifsc_code: 'HDFC0001234' });
  E.PAYI = await addEmployee(co, 'EMP008');
  E.PAYN = await addEmployee(co, 'EMP009');
  E.OTHER = await addEmployee(other, 'EMP001');
  await link(U.manager, E.MGR);
  await link(U.department_head, E.DH);
  await link(U.employee, E.SELF);

  const { rows: [s] } = await pool.query(
    `INSERT INTO salary_structures (name, description, is_default, components, company_id)
     VALUES ('PC-01 structure', 'fixture', true, '[]', $1) RETURNING id`, [co.companyId]);
  await pool.query(
    `INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from, basic_salary)
     VALUES ($1, $2, '2025-04-01', 30000)`, [E.PAYV, s.id]);

  await addRun(E.PAYV, 'draft', U.payroll_admin.userId);
  await addRun(E.PAYI, 'approved', U.finance_manager.userId, U.admin.userId);   // the payer prepared it; admin approved
  await addRun(E.PAYN, 'approved', null, U.admin.userId);                       // no recorded preparer

  R.R1 = await addRecommendation(E.R1);
  R.R2 = await addRecommendation(E.R2);
  R.X  = await addRecommendation(E.X);
  R.APPROVED = await addRecommendation(E.SELF, 'approved');

  // Company B
  B.hr = await addUser(pool, other, { label: 'hr', roleCode: 'hr' });
  B.payroll_admin = await addUser(pool, other, { label: 'payroll_admin', roleCode: 'payroll_admin' });

  // A login with NO company, holding an HR role.
  const { rows: [nu] } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active, role)
     VALUES ('PC01 no-company hr', $1, 'not-a-real-hash', NULL, true, 'hr') RETURNING id`, [NOCO_EMAIL]);
  const { rows: [hrRole] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = 'hr' LIMIT 1`);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [nu.id, hrRole.id]);
  noCo = { userId: nu.id, token: () => jwt.sign({ userId: nu.id, role: 'hr', company_id: null, employee_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' }) };

  // Multi-role: hr_exec (no payroll) + finance_manager (payroll view/approve/export).
  U.multi = await addUser(pool, co, { label: 'multi', roleCode: 'hr_exec' });
  const { rows: [fmRole] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = 'finance_manager' LIMIT 1`);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [U.multi.userId, fmRole.id]);

  // User-level override: an hr login whose `payroll` row is all false — it
  // replaces the role grant entirely.
  U.hrDenied = await addUser(pool, co, { label: 'hrdenied', roleCode: 'hr' });
  await pool.query(
    `INSERT INTO permissions (user_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
     VALUES ($1, 'payroll', false, false, false, false, false, false)`, [U.hrDenied.userId]);

  // finance:view ONLY (override on an employee login) — the old Form 24Q gate.
  U.finViewOnly = await addUser(pool, co, { label: 'finview', roleCode: 'employee' });
  await pool.query(
    `INSERT INTO permissions (user_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
     VALUES ($1, 'finance', true, false, false, false, false, false)`, [U.finViewOnly.userId]);
}, 60000);

afterAll(async () => {
  for (const c of [co, other]) {
    if (!c) continue;
    await sweep(c.companyId);
    await dropIsolatedCompany(pool, c.companyId);
  }
  await dropNoCompanyLogin();
});

// ── 1. Role × endpoint matrix ───────────────────────────────────────────────
const PAYROLL_VIEW = ['super_admin', 'admin', 'payroll_admin', 'hr_manager', 'hr', 'finance_manager'];
// Company-wide increments: performance:approve or payroll:edit — not finance_manager (closure decision 2).
const INCREMENTS_ALL = ['super_admin', 'admin', 'payroll_admin', 'hr_manager', 'hr'];
// A payment needs a bank reference and value date (PC-02a PD-1); PAYV is a draft and is never paid.
const PAY = { month: M, year: Y, reference: 'PC01TESTUTR0001', value_date: new Date().toISOString().slice(0, 10) };
const PAYROLL_WRITE = ['super_admin', 'admin', 'payroll_admin', 'hr_manager', 'hr'];
const PROBES = [
  { name: 'payroll:view    GET summary',          method: 'get',  path: () => `/api/payroll/summary?month=${M}&year=${Y}`, allow: PAYROLL_VIEW },
  { name: 'payroll:view    GET list',             method: 'get',  path: () => `/api/payroll?month=${M}&year=${Y}`, allow: PAYROLL_VIEW },
  { name: 'payroll:view    GET salary-structures', method: 'get', path: () => '/api/salary-structures', allow: PAYROLL_VIEW },
  { name: 'payroll:view    GET salary-revisions', method: 'get',  path: () => `/api/employees/${E.PAYV}/salary-revisions`, allow: PAYROLL_VIEW },
  { name: 'payroll:add     POST save-slip',       method: 'post', path: () => '/api/payroll/save-slip', body: {}, allow: PAYROLL_WRITE },
  { name: 'payroll:edit    POST arrears',         method: 'post', path: () => '/api/payroll/arrears', body: {}, allow: PAYROLL_WRITE },
  { name: 'payroll:export  GET register',         method: 'get',  path: () => `/api/payroll/register?month=${M}&year=${Y}`, allow: PAYROLL_VIEW },
  { name: 'payroll:approve POST approve',         method: 'post', path: () => '/api/payroll/approve', body: {},
    // PC-02a PD-2: payroll_admin no longer approves
    allow: ['super_admin', 'admin', 'finance_manager'] },
  { name: 'payroll_statutory_config:edit POST statutory-rules', method: 'post', path: () => '/api/payroll/statutory-rules', body: {},
    allow: ['super_admin', 'admin', 'payroll_admin'] },
  { name: 'salary_proposals:approve POST approve', method: 'post', path: () => '/api/salary-structures/proposals/2147483000/approve', body: {},
    // closure decision 1 (migration 20261104000002): Finance and the administrators only
    allow: ['super_admin', 'admin', 'finance_manager'] },
  { name: 'payroll_payment:approve POST mark-paid (draft run)', method: 'post', path: () => `/api/payroll/${E.PAYV}/mark-paid`, body: PAY,
    // PC-02a PD-3: the administrators may record payment too
    allow: ['finance_manager', 'admin', 'super_admin'] },
  { name: 'increments      GET recommendations',  method: 'get',  path: () => '/api/performance/increments/recommendations',
    allow: [...INCREMENTS_ALL, 'manager', 'department_head'] },
  { name: 'increments      GET budget-summary', method: 'get', path: () => '/api/performance/increments/budget-summary', allow: INCREMENTS_ALL },
  { name: 'payroll_tds_extract:export GET form24q', method: 'get', path: () => '/api/tds/form24q?financial_year=2030-2031&quarter=Q1',
    allow: ['super_admin', 'admin', 'finance_manager', 'finance', 'accounts_exec'] },
];

describe('PC-01 role × endpoint matrix', () => {
  for (const p of PROBES) {
    for (const role of ROLES) {
      const allowed = p.allow.includes(role);
      it(`${p.name} — ${role} ${allowed ? 'allowed' : 'denied'}`, async () => {
        let req = call(U[role], p.method, p.path());
        if (p.body) req = req.send(p.body);
        const res = await req;
        if (allowed) {
          expect(res.status, JSON.stringify(res.body)).not.toBe(403);
          expect(res.status, JSON.stringify(res.body)).not.toBe(401);
          expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
        } else {
          expect(res.status, JSON.stringify(res.body)).toBe(403);
        }
      });
    }
  }

  it('a denied matrix route answers with the permission code, not a handler message', async () => {
    const res = await call(U.hr_exec, 'get', `/api/payroll/summary?month=${M}&year=${Y}`);
    expect(res.status).toBe(403);
    expect(['PERMISSION_DENIED', 'PERMISSION_NOT_CONFIGURED']).toContain(res.body.code);
  });

  it('nothing was paid, approved or generated by the probes', async () => {
    const { rows } = await pool.query(
      `SELECT pr.employee_id, pr.status FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
        WHERE e.company_id = $1 ORDER BY pr.employee_id`, [co.companyId]);
    expect(rows.map(r => [r.employee_id, r.status])).toEqual([[E.PAYV, 'draft'], [E.PAYI, 'approved'], [E.PAYN, 'approved']]);
    const { rows: [a] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payroll_arrears WHERE employee_id IN (SELECT id FROM employees WHERE company_id = $1)`, [co.companyId]);
    expect(a.n).toBe(0);
    const { rows: [r] } = await pool.query(`SELECT COUNT(*)::int AS n FROM payroll_statutory_rules WHERE company_id = $1`, [co.companyId]);
    expect(r.n).toBe(0);
  });
});

// ── 2. Company isolation ────────────────────────────────────────────────────
describe('PC-01 company isolation', () => {
  it('HR of company A reads the salary history of its own employee', async () => {
    const res = await call(U.hr, 'get', `/api/employees/${E.PAYV}/salary-revisions`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(Number(res.body[0].basic_salary)).toBe(30000);
  });

  it("HR of company B gets none of company A's salary history", async () => {
    const res = await call(B.hr, 'get', `/api/employees/${E.PAYV}/salary-revisions`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('an HR login with no company is refused salary history (not read across tenants)', async () => {
    const res = await call(noCo, 'get', `/api/employees/${E.PAYV}/salary-revisions`);
    expect(res.status).toBe(403);
  });

  it("company B's payroll admin cannot mark company A's run paid or see its increments", async () => {
    const paid = await call(B.payroll_admin, 'post', `/api/payroll/${E.PAYV}/mark-paid`).send(PAY);
    expect(paid.status).toBe(403);
    const list = await call(B.hr, 'get', '/api/performance/increments/recommendations');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
    const one = await call(B.hr, 'get', `/api/performance/increments/recommendations/${R.R1}`);
    expect(one.status).toBe(404);
  });
});

// ── 3. Increments: direct reports only for manager / department_head ────────
describe('PC-01 increments direct-report scope (D7 / Q5)', () => {
  const ids = (body) => body.map(r => Number(r.id)).sort((a, b) => a - b);

  it('manager lists only the recommendation of their direct report', async () => {
    const res = await call(U.manager, 'get', '/api/performance/increments/recommendations');
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([R.R1]);
  });

  it('department_head lists only the recommendation of their direct report', async () => {
    const res = await call(U.department_head, 'get', '/api/performance/increments/recommendations');
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([R.R2]);
  });

  it('a payroll:view holder (hr) sees the whole company', async () => {
    const res = await call(U.hr, 'get', '/api/performance/increments/recommendations');
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([R.R1, R.R2, R.X, R.APPROVED].sort((a, b) => a - b));
  });

  it("a manager opening someone else's recommendation gets 404", async () => {
    expect((await call(U.manager, 'get', `/api/performance/increments/recommendations/${R.R1}`)).status).toBe(200);
    expect((await call(U.manager, 'get', `/api/performance/increments/recommendations/${R.X}`)).status).toBe(404);
    expect((await call(U.manager, 'get', `/api/performance/increments/recommendations/${R.R2}`)).status).toBe(404);
    expect((await call(U.department_head, 'get', `/api/performance/increments/recommendations/${R.R1}`)).status).toBe(404);
  });

  it('a manager may not create a recommendation for a non-report, or for another company', async () => {
    const notMine = await call(U.manager, 'post', '/api/performance/increments/recommendations')
      .send({ employee_id: E.X, recommended_increment_pct: 50 });
    expect(notMine.status).toBe(404);
    const otherCo = await call(U.manager, 'post', '/api/performance/increments/recommendations')
      .send({ employee_id: E.OTHER, recommended_increment_pct: 50 });
    expect(otherCo.status).toBe(404);
    const { rows: [n] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM increment_recommendations WHERE employee_id = ANY($1)`, [[E.X, E.OTHER]]);
    expect(n.n).toBe(1);   // only the fixture on X
  });

  it('a manager may create a recommendation for a direct report', async () => {
    const res = await call(U.manager, 'post', '/api/performance/increments/recommendations')
      .send({ employee_id: E.R1, recommended_increment_pct: 5, cycle_id: null });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Number(res.body.employee_id)).toBe(E.R1);
  });

  it('a line manager cannot approve, reject, read the budget or edit bands', async () => {
    expect((await call(U.manager, 'patch', `/api/performance/increments/recommendations/${R.R1}/approve`).send({})).status).toBe(403);
    expect((await call(U.manager, 'patch', `/api/performance/increments/recommendations/${R.R1}/reject`).send({})).status).toBe(403);
    expect((await call(U.manager, 'get', '/api/performance/increments/budget-summary')).status).toBe(403);
    expect((await call(U.manager, 'get', '/api/performance/increments/bands')).status).toBe(403);
    expect((await call(U.department_head, 'post', '/api/performance/increments/bands').send({})).status).toBe(403);
  });

  it('a manager with no linked employee record is refused (no company-wide fallback)', async () => {
    const loose = await addUser(pool, co, { label: 'loosemgr', roleCode: 'manager' });
    const res = await call(loose, 'get', '/api/performance/increments/recommendations');
    expect(res.status).toBe(403);
  });
});

// ── 4. Push to payroll outside CTC mode ─────────────────────────────────────
describe('PC-01 push-to-payroll without CTC mode (Q6)', () => {
  it('is refused with SALARY_PROPOSAL_REQUIRED and writes no salary', async () => {
    const res = await call(U.admin, 'post', `/api/performance/increments/recommendations/${R.APPROVED}/push-payroll`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('SALARY_PROPOSAL_REQUIRED');
    const { rows: [a] } = await pool.query(`SELECT COUNT(*)::int AS n FROM employee_salary_assignments WHERE employee_id = $1`, [E.SELF]);
    expect(a.n).toBe(0);
    const { rows: [e] } = await pool.query(`SELECT basic_salary FROM employees WHERE id = $1`, [E.SELF]);
    expect(e.basic_salary == null || Number(e.basic_salary) === 0).toBe(true);
    const { rows: [r] } = await pool.query(`SELECT status FROM increment_recommendations WHERE id = $1`, [R.APPROVED]);
    expect(r.status).toBe('approved');
  });

  it('needs payroll:edit — a manager is refused', async () => {
    const res = await call(U.manager, 'post', `/api/performance/increments/recommendations/${R.APPROVED}/push-payroll`).send({});
    expect(res.status).toBe(403);
  });
});

// ── 5. Mark paid: finance_manager only, never the preparer ──────────────────
describe('PC-01 mark-paid (D2 / Q1)', () => {
  it('the preparer cannot mark their own run paid', async () => {
    const res = await call(U.finance_manager, 'post', `/api/payroll/${E.PAYI}/mark-paid`).send(PAY);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('PAYER_IS_PREPARER');
  });

  it('a run with no recorded preparer is refused', async () => {
    const res = await call(U.finance_manager, 'post', `/api/payroll/${E.PAYN}/mark-paid`).send(PAY);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('PREPARER_UNKNOWN');
  });

  it('an authorised payer reaches the service, which still refuses an unapproved run', async () => {
    const res = await call(U.finance_manager, 'post', `/api/payroll/${E.PAYV}/mark-paid`).send(PAY);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBeUndefined();
  });

  it('hr, payroll_admin and hr_manager cannot record payment; admin cannot pay a run they approved', async () => {
    for (const role of ['hr', 'payroll_admin', 'hr_manager']) {
      const res = await call(U[role], 'post', `/api/payroll/${E.PAYI}/mark-paid`).send(PAY);
      expect(res.status, role).toBe(403);
      expect(res.body.code, role).toBe('PERMISSION_DENIED');
    }
    const admin = await call(U.admin, 'post', `/api/payroll/${E.PAYI}/mark-paid`).send(PAY);
    expect(admin.status).toBe(403);
    expect(admin.body.code).toBe('PAYER_IS_APPROVER');
  });

  it('no run changed status', async () => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
        WHERE e.company_id = $1 AND pr.status = 'paid'`, [co.companyId]);
    expect(rows[0].n).toBe(0);
  });
});

// ── 6. Statutory payroll switches (Q3) — in company B ───────────────────────
describe('PC-01 statutory payroll settings (Q3)', () => {
  const save = (who, body) => call(who, 'post', '/api/settings/payroll').send(body);
  const stored = async () => (await pool.query(
    `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'payroll'`, [other.companyId])).rows[0]?.settings ?? null;

  it('hr may save a non-statutory payroll setting', async () => {
    const res = await save(B.hr, { working_days: 25 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await stored()).working_days).toBe(25);
  });

  it('hr may not switch CTC mode on', async () => {
    const res = await save(B.hr, { ctc_mode: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('STATUTORY_CONFIG_PERMISSION');
    expect(res.body.keys).toContain('ctc_mode');
    expect(Boolean((await stored()).ctc_mode)).toBe(false);
  });

  it('hr may not turn PT off through the Setup Wizard key family', async () => {
    const res = await save(B.hr, { pt: { enabled: false } });
    expect(res.status).toBe(403);
    expect(res.body.keys).toContain('professional_tax');
  });

  it('hr may not change the statutory state', async () => {
    const res = await save(B.hr, { statutory_state: 'Karnataka' });
    expect(res.status).toBe(403);
    expect(res.body.keys).toContain('statutory_state');
  });

  it('payroll_admin may change a statutory switch, after which hr can still save other settings', async () => {
    const pa = await save(B.payroll_admin, { pf_enabled: false });
    expect(pa.status, JSON.stringify(pa.body)).toBe(200);
    expect((await stored()).pf_enabled).toBe(false);
    const hr = await save(B.hr, { working_days: 24 });
    expect(hr.status, JSON.stringify(hr.body)).toBe(200);
    expect((await stored()).pf_enabled).toBe(false);
  });
});

// ── 7. Form 24Q and the rest of TDS (D6 / Q4) ───────────────────────────────
describe('PC-01 Form 24Q extract permission', () => {
  it('payroll_admin and hr are refused 24Q', async () => {
    for (const role of ['payroll_admin', 'hr', 'hr_manager']) {
      const res = await call(U[role], 'get', '/api/tds/form24q-download?financial_year=2030-2031&quarter=Q1');
      expect(res.status, role).toBe(403);
    }
  });

  it('finance:view alone no longer opens 24Q — however the path is spelled', async () => {
    for (const path of ['/api/tds/form24q', '/api/tds/Form24Q/', '/api/tds/FORM24Q-DOWNLOAD', '/api/tds/form24q-download/']) {
      const res = await call(U.finViewOnly, 'get', `${path}?financial_year=2030-2031&quarter=Q1`);
      expect(res.status, path).toBe(403);
    }
  });

  it('the other TDS routes still need finance:view only', async () => {
    expect((await call(U.finViewOnly, 'get', '/api/tds/deductees')).status).toBe(200);
    expect((await call(U.payroll_admin, 'get', '/api/tds/deductees')).status).toBe(403);
    expect((await call(U.accounts_exec, 'get', '/api/tds/deductees')).status).toBe(200);
  });
});

// ── 8. Self-service, multi-role union, user-level deny ──────────────────────
describe('PC-01 self-service, role union and overrides', () => {
  it('an employee still reads their own payslips', async () => {
    const mine = await call(U.employee, 'get', '/api/payroll/my-payslips');
    expect(mine.status).toBe(200);
    const own = await call(U.employee, 'get', `/api/payroll/payslips?employee_id=${E.SELF}&month=${M}&year=${Y}`);
    expect(own.status).not.toBe(403);
    expect(own.status).toBeLessThan(500);
  });

  it("an employee cannot read a colleague's payslip or salary history", async () => {
    expect((await call(U.employee, 'get', `/api/payroll/payslips?employee_id=${E.PAYV}&month=${M}&year=${Y}`)).status).toBe(403);
    expect((await call(U.employee, 'get', `/api/employees/${E.SELF}/salary-revisions`)).status).toBe(403);
    expect((await call(U.employee, 'get', '/api/performance/increments/recommendations')).status).toBe(403);
  });

  it('grants are the union across roles (hr_exec + finance_manager)', async () => {
    expect((await call(U.multi, 'get', `/api/payroll/summary?month=${M}&year=${Y}`)).status).toBe(200);
    expect((await call(U.multi, 'post', '/api/payroll/save-slip').send({})).status).toBe(403);
    expect((await call(U.multi, 'post', '/api/payroll/approve').send({})).status).toBe(400);
  });

  it('a user-level permissions row replaces the role grant (hr with payroll all-false)', async () => {
    expect((await call(U.hrDenied, 'get', `/api/payroll/summary?month=${M}&year=${Y}`)).status).toBe(403);
    expect((await call(U.hrDenied, 'get', `/api/employees/${E.PAYV}/salary-revisions`)).status).toBe(403);
    // increments are not payroll-only: hr still runs the cycle through performance:approve
    expect((await call(U.hrDenied, 'get', '/api/performance/increments/recommendations')).status).toBe(200);
  });
});
