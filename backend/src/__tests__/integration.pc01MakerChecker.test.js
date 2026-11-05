/**
 * PC-01 closure — payroll approval maker-checker, exercised directly.
 *
 *   1. the preparer cannot approve their own run (even holding payroll:approve)
 *   2. a different authorised Finance user (finance_manager) can approve
 *   3. roles without payroll:approve are refused
 *   4. company boundaries: another company's approver sees none of the runs
 *
 * The release gate answers before maker-checker, so each company is made
 * release-ready first — exactly as integration.payrollEndToEnd does (statutory
 * rule versions confirmed, jurisdiction recorded). The drafts are inserted as
 * fixtures (no Run Payroll); the one approval happens on synthetic employees in
 * a throwaway company of the isolated test database and is removed with it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }           = await import('../config/db.js');
const { verifyToken }             = await import('../middlewares/auth.middleware.js');
const { buildApp }                = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { default: payrollRoutes }  = await import('../modules/payroll/payroll.routes.js');
const { default: settingsRoutes } = await import('../modules/admin/settings-status.routes.js');

const app = buildApp(
  ['/api/payroll', verifyToken, payrollRoutes],
  ['/api/settings', verifyToken, settingsRoutes],
);

const PREFIX = 'ZZPC01MC';
const M = 1, Y = 2030;      // fixture period — far from any real run
// payroll_admin prepares but no longer approves (PC-02a PD-2).
const DENIED = ['payroll_admin', 'hr', 'hr_manager', 'hr_exec', 'manager', 'department_head', 'finance', 'accounts_exec', 'employee'];
let co, other;
const U = {}, B = {}, E = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);
const approve = (who, month = M) => call(who, 'post', '/api/payroll/approve').send({ month, year: Y });

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  const q = (sql) => pool.query(sql, [companyId]);
  await q(`UPDATE users SET employee_id = NULL WHERE company_id = $1`);
  await q(`DELETE FROM payslip_email_log WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM tds_transactions WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM tds_deductees WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_runs WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM employee_salary_assignments WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM journal_lines WHERE company_id = $1`);
  await q(`DELETE FROM journal_entries WHERE company_id = $1`);
  await q(`DELETE FROM payroll_statutory_rules WHERE company_id = $1`);
  await q(`DELETE FROM company_settings WHERE company_id = $1`);
  await q(`DELETE FROM employees WHERE company_id = $1`);
}

async function addEmployee(company, code) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date,
                            pan_number, account_number, ifsc_code, uan_number)
     VALUES ($1, $2, $2, 'Mc', 'Active', '2026-04-01', 'ABCDE1234F', '123456789012', 'HDFC0001234', '100200300400')
     RETURNING id`, [company.companyId, code]);
  await pool.query(
    `INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from, basic_salary)
     VALUES ($1, NULL, '2026-04-01', 30000)`, [r.id]);
  return r.id;
}

async function addDraft(employeeId, month, preparerUserId) {
  await pool.query(
    `INSERT INTO payroll_runs (employee_id, month, year, status, gross, net_pay, total_deductions, tds,
                               employee_pf, employer_pf, employee_esi, employer_esi, professional_tax, ctc_monthly, is_test, generated_by)
     VALUES ($1, $2, $3, 'pending', 30000, 30000, 0, 0, 0, 0, 0, 0, 0, 30000, false, $4)`, [employeeId, month, Y, preparerUserId]);
}

/** Confirm every statutory rule version the period depends on, and record the jurisdiction. */
async function makeReady(who, company, month) {
  await pool.query(`UPDATE companies SET state = 'Karnataka' WHERE id = $1`, [company.companyId]);
  const s = await call(who, 'post', '/api/settings/payroll').send({ statutory_state: 'Karnataka', pay_day_of_month: 25, payroll_cutoff_day: 20 });
  if (s.status !== 200) throw new Error(`settings: ${s.status} ${JSON.stringify(s.body)}`);
  const r = await call(who, 'get', `/api/payroll/release-readiness?month=${month}&year=${Y}`);
  for (const b of r.body.data.blockers.filter(x => x.code.startsWith('RULE_'))) {
    const effective_from = b.code === 'RULE_MID_PERIOD' ? `${Y}-${String(month).padStart(2, '0')}-01` : b.effective_from;
    const res = await call(who, 'post', '/api/payroll/statutory-rules')
      .send({ rule_key: b.key, effective_from, value: b.value, source_reference: `PC-01 maker-checker fixture ${b.key}` });
    if (res.status !== 201) throw new Error(`confirm ${b.key}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const after = await call(who, 'get', `/api/payroll/release-readiness?month=${month}&year=${Y}`);
  if (!after.body.data.ready) throw new Error(`not release-ready: ${JSON.stringify(after.body.data.blockers)}`);
}

const statuses = async (company) => (await pool.query(
  `SELECT pr.month, e.office_id, pr.status FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
    WHERE e.company_id = $1 ORDER BY pr.month, e.office_id`, [company.companyId])).rows.map(r => `${r.month}:${r.office_id}:${r.status}`);

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  for (const role of [...new Set(['payroll_admin', 'finance_manager', ...DENIED])]) U[role] = await addUser(pool, co, { label: `r_${role}`, roleCode: role });
  U.fm2 = await addUser(pool, co, { label: 'fm2', roleCode: 'finance_manager' });
  // The preparer who ALSO holds payroll:approve: an administrator.
  U.adminPreparer = await addUser(pool, co, { label: 'prep_admin', roleCode: 'admin' });
  B.payroll_admin = await addUser(pool, other, { label: 'payroll_admin', roleCode: 'payroll_admin' });
  B.finance_manager = await addUser(pool, other, { label: 'finance_manager', roleCode: 'finance_manager' });

  E.A1 = await addEmployee(co, 'EMP001');
  E.A2 = await addEmployee(co, 'EMP002');
  // Month M: prepared by payroll_admin. Month M+1: prepared by finance_manager.
  await addDraft(E.A1, M, U.adminPreparer.userId);
  await addDraft(E.A2, M, U.adminPreparer.userId);
  await addDraft(E.A1, M + 1, U.finance_manager.userId);

  await makeReady(U.payroll_admin, co, M);
  await makeReady(U.payroll_admin, co, M + 1);
  await makeReady(B.payroll_admin, other, M);       // ready, but with no runs of its own
}, 120000);

afterAll(async () => {
  for (const c of [co, other]) {
    if (!c) continue;
    await sweep(c.companyId);
    await dropIsolatedCompany(pool, c.companyId);
  }
});

describe('PC-01 payroll approval maker-checker', () => {
  it('roles without payroll:approve are refused, and nothing changes', async () => {
    for (const role of DENIED) {
      const res = await approve(U[role]);
      expect(res.status, role).toBe(403);
      expect(['PERMISSION_DENIED', 'PERMISSION_NOT_CONFIGURED'], role).toContain(res.body.code);
    }
    expect(await statuses(co)).toEqual(['1:EMP001:pending', '1:EMP002:pending', '2:EMP001:pending']);
  });

  it("another company's approver sees none of the runs", async () => {
    const res = await approve(B.finance_manager);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.message).toMatch(/No pending payroll records/);
    expect(await statuses(co)).toEqual(['1:EMP001:pending', '1:EMP002:pending', '2:EMP001:pending']);
  });

  it('the preparer cannot approve their own run, though they hold payroll:approve', async () => {
    const res = await approve(U.adminPreparer);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('MAKER_CHECKER');
    expect(res.body.employees).toEqual(['EMP001', 'EMP002']);
    expect(await statuses(co)).toEqual(['1:EMP001:pending', '1:EMP002:pending', '2:EMP001:pending']);
  });

  it('a Finance approver who prepared a run cannot approve it either', async () => {
    const res = await approve(U.finance_manager, M + 1);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('MAKER_CHECKER');
    expect(await statuses(co)).toEqual(['1:EMP001:pending', '1:EMP002:pending', '2:EMP001:pending']);
  });

  it('a different authorised Finance user approves — that period only, that company only', async () => {
    const res = await approve(U.finance_manager);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ approved_count: 2 });
    expect(await statuses(co)).toEqual(['1:EMP001:approved', '1:EMP002:approved', '2:EMP001:pending']);
    const { rows: [n] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id WHERE e.company_id = $1`, [other.companyId]);
    expect(n.n).toBe(0);
  });

  it('the run prepared by one Finance user is approved by another', async () => {
    const res = await approve(U.fm2, M + 1);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statuses(co)).toEqual(['1:EMP001:approved', '1:EMP002:approved', '2:EMP001:approved']);
  });

  it('nothing was paid', async () => {
    const { rows: [n] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
        WHERE e.company_id = ANY($1) AND pr.status = 'paid'`, [[co.companyId, other.companyId]]);
    expect(n.n).toBe(0);
  });
});
