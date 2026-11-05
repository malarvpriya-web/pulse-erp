/**
 * Loan GL safety — PAYROLL_DATA_FLOW_AUDIT.md Part 14.
 *
 * A payroll batch that recovers a loan is refused (and changes nothing) until
 * Finance has approved the accounts its principal and interest post to; only
 * finance:approve can set them, the generic settings writer cannot forge them,
 * and the journal posts principal → receivable, interest → income, balanced.
 * Real routers, real database, a throwaway company with synthetic employees.
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
const { default: settingsRoutes } = await import('../modules/admin/settings-status.routes.js');
const { default: accountingRoutes } = await import('../modules/finance/accounting.routes.js');
const { auditMutations }         = await import('../middlewares/auditMutations.js');
const { postPayrollJournal }     = await import('../modules/finance/services/payrollJournal.service.js');

const app = buildApp(
  ['/api/payroll', verifyToken, payrollRoutes],
  ['/api/settings', verifyToken, auditMutations('settings'), settingsRoutes],
  ['/api/finance/accounting', verifyToken, auditMutations('finance'), accountingRoutes],
);

const PREFIX = 'ZZLNGL';
const MAP = '/api/finance/accounting/loan-gl-mapping';
let co, checker, finance, hr;
let empLoan, empPlain, loanId;
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);

async function confirmRules(who, month, year) {
  const r = await call(who, 'get', `/api/payroll/release-readiness?month=${month}&year=${year}`);
  for (const b of r.body.data.blockers.filter(x => x.code.startsWith('RULE_'))) {
    const effective_from = b.code === 'RULE_MID_PERIOD' ? `${year}-${String(month).padStart(2, '0')}-01` : b.effective_from;
    const res = await call(who, 'post', '/api/payroll/statutory-rules')
      .send({ rule_key: b.key, effective_from, value: b.value, source_reference: `Loan GL suite confirmation of ${b.code} ${b.key}` });
    if (res.status !== 201) throw new Error(`confirm ${b.key} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  const q = (sql) => pool.query(sql, [companyId]);
  await q(`DELETE FROM payroll_loan_repayments WHERE loan_id IN (SELECT id FROM payroll_loans WHERE employee_id IN ${emps})`);
  await q(`DELETE FROM payroll_loans WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_arrears WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM tds_transactions WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_runs WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM employee_salary_assignments WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM journal_lines WHERE company_id = $1`);
  await q(`DELETE FROM journal_entries WHERE company_id = $1`);
  await q(`DELETE FROM payroll_statutory_rules WHERE company_id = $1`);
  await q(`DELETE FROM company_settings WHERE company_id = $1`);
  await q(`DELETE FROM employees WHERE company_id = $1`);
}

async function addEmployee(code) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, pan_number, account_number, ifsc_code, uan_number)
     VALUES ($1, $2, $2, 'Fixture', 'Active', '2026-04-01', 'ABCDE1234F', '123456789012', 'HDFC0001234', '100200300400') RETURNING id`,
    [co.companyId, code]);
  await pool.query(`INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from, basic_salary) VALUES ($1, NULL, '2026-04-01', 30000)`, [r.id]);
  return r.id;
}

const state = async () => ({
  runs: (await pool.query(`SELECT pr.status, COUNT(*)::int n FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id WHERE e.company_id = $1 GROUP BY 1 ORDER BY 1`, [co.companyId])).rows,
  repayments: (await pool.query(`SELECT COUNT(*)::int n FROM payroll_loan_repayments WHERE loan_id = $1`, [loanId])).rows[0].n,
  balance: Number((await pool.query(`SELECT outstanding_balance FROM payroll_loans WHERE id = $1`, [loanId])).rows[0].outstanding_balance),
  journals: (await pool.query(`SELECT COUNT(*)::int n FROM journal_entries WHERE company_id = $1`, [co.companyId])).rows[0].n,
});

async function journalFor(tag) {
  const { rows } = await pool.query(
    `SELECT jl.account_code, SUM(jl.debit)::float AS d, SUM(jl.credit)::float AS c
       FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE je.company_id = $1 AND je.reference_type = 'payroll_run' AND je.reference_id LIKE $2
      GROUP BY jl.account_code`, [co.companyId, `${tag}:%`]);
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    found: rows.length > 0,
    debit: r2(rows.reduce((t, r) => t + r.d, 0)), credit: r2(rows.reduce((t, r) => t + r.c, 0)),
    lines: Object.fromEntries(rows.map(r => [r.account_code, r2(r.c - r.d)])),
  };
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  checker = await addUser(pool, co);
  finance = await addUser(pool, co, { label: 'finance', roleCode: 'finance' });
  hr = await addUser(pool, co, { label: 'hrmgr', roleCode: 'hr_manager' });
  await pool.query(`UPDATE companies SET state = 'Karnataka', tan = 'BLRZ12345A' WHERE id = $1`, [co.companyId]);
  empLoan = await addEmployee('EMP001');
  empPlain = await addEmployee('EMP002');
  const s = await call(co, 'post', '/api/settings/payroll').send({ statutory_state: 'Karnataka', pay_day_of_month: 25, payroll_cutoff_day: 20 });
  if (s.status !== 200) throw new Error(`settings: ${s.status} ${JSON.stringify(s.body)}`);
  // ₹60,000 at 12% for 12 months, first deduction December 2026
  const l = await call(co, 'post', '/api/payroll/loan-advances')
    .send({ employee_id: empLoan, loan_type: 'loan', principal_amount: 60000, interest_rate: 12, tenure_months: 12, start_date: '2026-12-01' });
  if (l.status !== 201) throw new Error(`loan: ${l.status} ${JSON.stringify(l.body)}`);
  loanId = l.body.id;
}, 60000);

afterAll(async () => {
  if (co) { await sweep(co.companyId); await dropIsolatedCompany(pool, co.companyId); }
}, 60000);

describe('loan account mapping is a Finance decision', () => {
  it('starts unconfigured — nothing is assumed', async () => {
    const r = await call(finance, 'get', MAP);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'not_configured', accounts: {} });
  });

  it('only finance:approve may set it; the generic settings writer cannot forge it', async () => {
    const body = { receivable_account_code: '1013', interest_income_account_code: '4006' };
    expect((await call(hr, 'put', MAP).send(body)).status).toBe(403);
    const forged = await call(co, 'post', '/api/settings/loan_gl_mapping').send({ ...body, approved_by: 1, approved_at: '2026-01-01' });
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe('SETTINGS_KEY_RESERVED');
    expect((await call(finance, 'get', MAP)).body.status).toBe('not_configured');
  });

  it('refuses accounts that do not exist or are the wrong type', async () => {
    const r = await call(finance, 'put', MAP).send({ receivable_account_code: '4006', interest_income_account_code: '99999' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('LOAN_GL_MAPPING_INVALID');
    expect(r.body.problems.join(' | ')).toMatch(/4006 .* is Revenue, must be Asset/);
    expect(r.body.problems.join(' | ')).toMatch(/99999 does not exist/);
    expect((await call(finance, 'get', MAP)).body.status).toBe('not_configured');
  });
});

describe('payroll approval with and without an approved mapping', () => {
  it('a batch with NO loan recovery approves normally while unmapped; its journal balances', async () => {
    await call(co, 'post', '/api/payroll/generate').send({ month: 11, year: 2026 });
    await confirmRules(co, 11, 2026);
    const ok = await call(checker, 'post', '/api/payroll/approve').send({ month: 11, year: 2026 });
    expect(ok.status).toBe(200);
    expect(ok.body.gl_posting).toMatchObject({ success: true });
    const gl = await journalFor('2026-11');
    expect(gl.debit).toBe(gl.credit);
    expect(gl.lines['1013']).toBeUndefined();
  });

  it('a batch that recovers a loan is refused while unmapped — and nothing changes', async () => {
    await call(co, 'post', '/api/payroll/generate').send({ month: 12, year: 2026 });
    await confirmRules(co, 12, 2026);
    const before = await state();
    const r = await call(checker, 'post', '/api/payroll/approve').send({ month: 12, year: 2026 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('LOAN_GL_MAPPING_REQUIRED');
    expect(r.body.message).toMatch(/Finance has not approved the GL accounts/);
    // rolled back: drafts still pending, no repayment, balance and GL untouched
    expect(await state()).toEqual(before);
    expect(before.balance).toBe(60000);
    expect(before.repayments).toBe(0);
  });

  it('maker-checker still applies once mapped — the gate bypasses nothing', async () => {
    const m = await call(finance, 'put', MAP).send({ receivable_account_code: '1013', interest_income_account_code: '4006', note: 'fixture' });
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ status: 'approved', approved_by: finance.userId });
    expect(m.body.accounts.receivable.code).toBe('1013');
    const own = await call(co, 'post', '/api/payroll/approve').send({ month: 12, year: 2026 });
    expect(own.status).toBe(403);
  });

  it('once Finance has mapped the accounts: principal → receivable, interest → income, balanced', async () => {
    const ok = await call(checker, 'post', '/api/payroll/approve').send({ month: 12, year: 2026 });
    expect(ok.status).toBe(200);
    expect(ok.body.gl_posting).toMatchObject({ success: true });
    const { rows: [rep] } = await pool.query(`SELECT amount::float, interest_component::float AS i, principal_component::float AS p FROM payroll_loan_repayments WHERE loan_id = $1`, [loanId]);
    expect(rep).toEqual({ amount: 5331, i: 600, p: 4731 });
    const gl = await journalFor('2026-12');
    expect(gl.debit).toBe(gl.credit);
    expect(gl.lines['1013']).toBe(4731);
    expect(gl.lines['4006']).toBe(600);
    expect((await state()).balance).toBe(55269);
  });

  it('withdrawing the mapping blocks the next loan batch again', async () => {
    const d = await call(finance, 'delete', MAP);
    expect(d.status).toBe(200);
    expect(d.body.status).toBe('not_configured');
    await call(co, 'post', '/api/payroll/generate').send({ month: 1, year: 2027 });
    await confirmRules(co, 1, 2027);
    const before = await state();
    const r = await call(checker, 'post', '/api/payroll/approve').send({ month: 1, year: 2027 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('LOAN_GL_MAPPING_REQUIRED');
    expect(await state()).toEqual(before);
  });
});

describe('the journal itself fails safe', () => {
  const base = { payroll_month: '2027-02', gross_salary: 75000, net_salary: 69669, pf_employer: 0, esi_employer: 0 };

  it('loan amounts with no approved mapping: skipped, nothing written', async () => {
    const before = await state();
    const r = await postPayrollJournal({ ...base, payroll_run_id: 'zz-a', loan_principal: 4731, loan_interest: 600, companyId: co.companyId });
    expect(r).toMatchObject({ skipped: true, code: 'LOAN_GL_MAPPING_REQUIRED' });
    expect((await state()).journals).toBe(before.journals);
  });

  it('an entry that would not balance is refused, never posted', async () => {
    await call(finance, 'put', MAP).send({ receivable_account_code: '1013', interest_income_account_code: '4006' });
    const before = await state();
    // 75,000 gross vs 69,669 net + 5,000 loan: 331 short
    const r = await postPayrollJournal({ ...base, payroll_run_id: 'zz-b', loan_principal: 5000, loan_interest: 0, companyId: co.companyId });
    expect(r).toMatchObject({ skipped: true, code: 'JOURNAL_UNBALANCED' });
    expect((await state()).journals).toBe(before.journals);
    // and the same figures that DO add up post, split
    const ok = await postPayrollJournal({ ...base, payroll_run_id: 'zz-c', loan_principal: 4731, loan_interest: 600, companyId: co.companyId });
    expect(ok).toMatchObject({ success: true });
  });

  it('net pay of 0 is credited as 0, not as gross', async () => {
    const r = await postPayrollJournal({ payroll_run_id: 'zz-d', payroll_month: '2027-03', gross_salary: 10000, net_salary: 0, pf_employer: 0, esi_employer: 0,
      loan_principal: 10000, loan_interest: 0, companyId: co.companyId });
    expect(r).toMatchObject({ success: true });
    expect(r.summary.salary_payable).toBe(0);
  });
});
