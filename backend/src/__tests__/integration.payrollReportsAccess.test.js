/**
 * Payroll access and report status semantics — PAYROLL_DATA_FLOW_AUDIT.md Part 12.
 *
 *  1. GET /self-service/dashboard resolves the employee on the SERVER: own
 *     record for everyone, another employee of the SAME company only for the
 *     payroll HR/Finance roles. It used to trust ?employee_id= behind
 *     verifyToken alone.
 *  2. Payroll Register and Department Cost separate finalised (approved/paid)
 *     payroll from drafts; on_hold / test rows are in neither.
 *
 * Real routers and database; two throwaway companies, synthetic employees and
 * payroll rows only — all removed afterwards.
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

const { default: pool }          = await import('../config/db.js');
const { verifyToken }            = await import('../middlewares/auth.middleware.js');
const { buildApp }               = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { default: payrollRoutes } = await import('../modules/payroll/payroll.routes.js');
const { default: selfServiceRoutes } = await import('../modules/hr/selfservice.routes.js');

const app = buildApp(
  ['/api/payroll', verifyToken, payrollRoutes],
  ['/api/self-service', verifyToken, selfServiceRoutes],
);

const PREFIX = 'ZZPAYRA';
let co, other, emp, hr, fin, unlinked;
const E = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);

// The dashboard's FY is the server's current Indian FY; build rows inside it.
const now = new Date();
const FY0 = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  await pool.query(`UPDATE users SET employee_id = NULL WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM payroll_runs WHERE employee_id IN ${emps}`, [companyId]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [companyId]);
}

async function addEmployee(company, code, department = 'Production') {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, department)
     VALUES ($1, $2, $2, 'Fixture', 'Active', '2025-04-01', $3) RETURNING id`, [company.companyId, code, department]);
  return r.id;
}

async function addRun(employeeId, month, year, status, { gross = 50000, tds = 0, isTest = false } = {}) {
  await pool.query(
    `INSERT INTO payroll_runs (employee_id, month, year, status, gross, net_pay, total_deductions, tds,
                               employee_pf, employer_pf, employee_esi, employer_esi, professional_tax, ctc_monthly, is_test)
     VALUES ($1,$2,$3,$4,$5::numeric,$5::numeric - $6::numeric,$6::numeric,$6::numeric,0,0,0,0,0,$5::numeric,$7)`, [employeeId, month, year, status, gross, tds, isTest]);
}

beforeAll(async () => {
  for (const id of [...await leftoverCompanies(pool, PREFIX)]) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  E.A = await addEmployee(co, 'EMP001');
  E.B = await addEmployee(co, 'EMP002');
  E.C = await addEmployee(other, 'EMP001');
  // Logins. The employee's link is on the users row only — the token carries
  // employee_id: null, so the server must resolve it, not trust a query param.
  emp = await addUser(pool, co, { label: 'emp', roleCode: 'employee' });
  await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [E.A, emp.userId]);
  hr = await addUser(pool, co, { label: 'hr', roleCode: 'hr_manager' });
  fin = await addUser(pool, co, { label: 'fin', roleCode: 'finance_manager' });
  unlinked = await addUser(pool, co, { label: 'nolink', roleCode: 'employee' });

  // YTD inputs for A (current FY): approved 1,000 + paid 200 count; the draft,
  // the test row and last FY's March do not.
  await addRun(E.A, 5, FY0, 'approved', { tds: 1000 });
  await addRun(E.A, 6, FY0, 'paid', { tds: 200 });
  await addRun(E.A, 7, FY0, 'pending', { tds: 500 });
  await addRun(E.A, 8, FY0, 'approved', { tds: 999, isTest: true });
  await addRun(E.A, 3, FY0, 'approved', { tds: 7777 });
  await addRun(E.B, 5, FY0, 'approved', { tds: 3000 });
  await addRun(E.C, 5, FY0, 'approved', { tds: 4444 });
}, 60000);

afterAll(async () => {
  for (const c of [co, other]) if (c) { await sweep(c.companyId); await dropIsolatedCompany(pool, c.companyId); }
}, 60000);

describe('self-service dashboard — server-side authorisation', () => {
  it('an employee reads their own record (no id, or their own id)', async () => {
    const r = await call(emp, 'get', '/api/self-service/dashboard');
    expect(r.status).toBe(200);
    expect(r.body.ytd_tax_deducted).toBe(1200);
    const own = await call(emp, 'get', `/api/self-service/dashboard?employee_id=${E.A}`);
    expect(own.status).toBe(200);
    expect(own.body.ytd_tax_deducted).toBe(1200);
  });

  it('an employee cannot read another employee of the same company', async () => {
    const r = await call(emp, 'get', `/api/self-service/dashboard?employee_id=${E.B}`);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ message: 'You may only view your own records' });
  });

  it('an employee cannot read an employee of another company', async () => {
    const r = await call(emp, 'get', `/api/self-service/dashboard?employee_id=${E.C}`);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toMatch(/4444|ytd/);
  });

  // §202: the self-service dashboard is the caller's OWN only — no role or
  // grant opens a colleague's (no screen reads one). HR reads payroll figures
  // through Payroll Center, whose routes keep their own rule.
  it("HR and Finance cannot read a colleague's self-service dashboard, in or out of the company", async () => {
    for (const [who, id] of [[hr, E.B], [fin, E.A], [hr, E.C], [hr, 999999999]]) {
      const r = await call(who, 'get', `/api/self-service/dashboard?employee_id=${id}`);
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).not.toMatch(/ytd|3000|1200|4444/);
    }
  });

  it('an account with no linked employee, or a malformed id, gets nothing', async () => {
    expect((await call(unlinked, 'get', '/api/self-service/dashboard')).status).toBe(403);
    expect((await call(hr, 'get', '/api/self-service/dashboard')).status).toBe(403);
    expect((await call(emp, 'get', '/api/self-service/dashboard?employee_id=1%20OR%201=1')).status).toBe(400);
  });
});

describe('Payroll Register and Department Cost — draft vs finalised', () => {
  // November 2025 for company `co`:
  //   A approved 60,000 · B paid 40,000            → finalised 1,00,000
  //   D pending 30,000                              → draft
  //   F on_hold 20,000                              → excluded
  //   G approved 99,999 is_test                     → nowhere
  beforeAll(async () => {
    E.D = await addEmployee(co, 'EMP004', 'Stores');
    E.F = await addEmployee(co, 'EMP006');
    E.G = await addEmployee(co, 'EMP007');
    await addRun(E.A, 11, 2025, 'approved', { gross: 60000 });
    await addRun(E.B, 11, 2025, 'paid', { gross: 40000 });
    await addRun(E.D, 11, 2025, 'pending', { gross: 30000 });
    await addRun(E.F, 11, 2025, 'on_hold', { gross: 20000 });
    await addRun(E.G, 11, 2025, 'approved', { gross: 99999, isTest: true });
    await addRun(E.D, 12, 2025, 'pending', { gross: 30000 });   // a month with drafts only
  });

  const csvRows = (text) => text.trim().split('\n').slice(1).map(l => l.split(','));

  it('the register defaults to FINALISED payroll: approved and paid only, labelled', async () => {
    const r = await call(hr, 'get', '/api/payroll/register?month=11&year=2025');
    expect(r.status).toBe(200);
    expect(r.headers['x-payroll-basis']).toBe('final');
    expect(r.headers['content-disposition']).toMatch(/_FINAL\.csv/);
    const rows = csvRows(r.text);
    expect(rows.map(x => x[0]).sort()).toEqual(['EMP001', 'EMP002']);
    expect(rows.map(x => x[24]).sort()).toEqual(['Approved (final)', 'Paid (final)']);
  });

  it('the preparation register keeps drafts visible, marked as drafts', async () => {
    const r = await call(hr, 'get', '/api/payroll/register?month=11&year=2025&basis=preparation');
    expect(r.status).toBe(200);
    expect(r.headers['x-payroll-basis']).toBe('preparation');
    expect(r.headers['x-payroll-draft-rows']).toBe('1');
    expect(r.headers['content-disposition']).toMatch(/PREPARATION_includes_drafts/);
    const rows = csvRows(r.text);
    expect(rows.map(x => x[0]).sort()).toEqual(['EMP001', 'EMP002', 'EMP004']);
    expect(rows.find(x => x[0] === 'EMP004')[24]).toBe('DRAFT - not approved');
    // on_hold and test rows are in neither basis
    expect(rows.map(x => x[0])).not.toContain('EMP006');
    expect(rows.map(x => x[0])).not.toContain('EMP007');
  });

  it('a month with only drafts has no final register; an unknown basis is refused', async () => {
    const r = await call(hr, 'get', '/api/payroll/register?month=12&year=2025');
    expect(r.status).toBe(404);
    expect(r.body.message).toMatch(/basis=preparation/);
    expect((await call(hr, 'get', '/api/payroll/register?month=12&year=2025&basis=preparation')).status).toBe(200);
    expect((await call(hr, 'get', '/api/payroll/register?month=11&year=2025&basis=all')).status).toBe(400);
  });

  it('department cost totals are finalised only; drafts are reported apart', async () => {
    const r = await call(fin, 'get', '/api/payroll/dept-cost?month=11&year=2025');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ basis: 'final', statuses_included: ['approved', 'paid'], excluded_rows: 1 });
    expect(r.body.grand_total).toMatchObject({ employee_count: 2, approved_count: 1, paid_count: 1, total_gross: 100000, total_employer_cost: 100000 });
    expect(r.body.draft.grand_total).toMatchObject({ employee_count: 1, total_gross: 30000 });
    expect(r.body.draft.departments.map(d => d.department)).toEqual(['Stores']);
    expect(r.body.draft.label).toMatch(/not approved/);
  });

  it('there are no superseded rows to double count: one row per employee and month', async () => {
    let err = null;
    try { await addRun(E.A, 11, 2025, 'approved', { gross: 1 }); } catch (e) { err = e; }
    expect(err?.code).toBe('23505');
    const r = await call(fin, 'get', '/api/payroll/dept-cost?month=11&year=2025');
    expect(r.body.grand_total.total_gross).toBe(100000);
  });

  it('another company sees none of it', async () => {
    const r = await call(other, 'get', '/api/payroll/dept-cost?month=11&year=2025');
    expect(r.body.grand_total.employee_count).toBe(0);
    expect(r.body.draft.grand_total.employee_count).toBe(0);
    expect((await call(other, 'get', '/api/payroll/register?month=11&year=2025&basis=preparation')).status).toBe(404);
  });
});

describe('My Payslips (Home widget source) — the official payslip lists', () => {
  // A finalised month carrying the lines the widget used to drop:
  // gross 54,000 = Basic 30,000 + HRA 12,000 + Special 10,000 + arrears 2,000;
  // deductions 3,000 PF + 2,000 loan EMI + 25 LWF + 500 advance = 5,525; net 48,475.
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO payroll_runs (employee_id, month, year, status, gross, net_pay, total_deductions, tds, basic, hra, special_allowance,
                                 arrears_amount, employee_pf, employer_pf, eps, epf_employer, employee_esi, employer_esi, professional_tax,
                                 lwf_employee, lwf_employer, loan_deduction, advance_deduction, ctc_monthly)
       VALUES ($1, 9, $2, 'approved', 54000, 48475, 5525, 0, 30000, 12000, 10000,
               2000, 3000, 3000, 1250, 1750, 0, 0, 0, 25, 50, 2000, 500, 57050)`, [E.A, FY0]);
  });

  it('each listed slip carries earnings / deductions / employer lists that reconcile to the stored run', async () => {
    const r = await call(emp, 'get', '/api/payroll/my-payslips');
    expect(r.status).toBe(200);
    const sep = r.body.data.find(p => p.month === 9 && p.year === FY0);
    expect(sep).toBeTruthy();
    const s = sep.slip;
    expect(s.deductions.map(d => d.label)).toEqual(expect.arrayContaining(['Loan EMI', 'Advance Recovery', 'Labour Welfare Fund (Employee)']));
    expect(s.earnings.map(e => e.label)).toContain('Arrears');
    expect(s.earnings.reduce((t, e) => t + e.amount, 0)).toBe(54000);
    expect(s.deductions.reduce((t, d) => t + d.amount, 0)).toBe(5525);
    expect(s.gross - s.total_deductions).toBe(s.net_pay);
    expect(sep.net_pay).toBe(48475);
    // employer PF is listed apart and never inside deductions
    expect(s.deductions.map(d => d.label).join('|')).not.toMatch(/Employer/);
    expect(s.employer_contributions_list.map(c => c.label)).toEqual(expect.arrayContaining(['Provident Fund (Employer) — EPS', 'Labour Welfare Fund (Employer)']));
    // drafts never appear in the employee's own list
    expect(r.body.data.some(p => p.status === 'pending')).toBe(false);
  });
});
