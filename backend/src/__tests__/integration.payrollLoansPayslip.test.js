/**
 * Loans & Advances end to end — PAYROLL_DATA_FLOW_AUDIT.md Part 11.
 *
 * Create (validated) → draft deducts the installment → approval records the
 * interest / principal split → prepayment in a month that also has a payroll
 * recovery → close refuses a balance → waiver needs a reason. Plus: seed
 * (is_test) loans are neither listed nor recovered, and every structure
 * component is on the payslip. Real routers, real database, a throwaway
 * company with synthetic employees only.
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
const { default: salaryRoutes }  = await import('../modules/payroll/salaryStructure.routes.js');
const { default: settingsRoutes } = await import('../modules/admin/settings-status.routes.js');
const { auditMutations }         = await import('../middlewares/auditMutations.js');
const { default: accountingRoutes } = await import('../modules/finance/accounting.routes.js');

const app = buildApp(
  ['/api/payroll', verifyToken, payrollRoutes],
  ['/api/salary-structures', verifyToken, salaryRoutes],
  ['/api/settings', verifyToken, auditMutations('settings'), settingsRoutes],
  ['/api/finance/accounting', verifyToken, auditMutations('finance'), accountingRoutes],
);

const PREFIX = 'ZZPAYLN';
let co, checker;
const E = {};
let loanId;
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);

async function confirmRules(who, month, year) {
  const r = await call(who, 'get', `/api/payroll/release-readiness?month=${month}&year=${year}`);
  for (const b of r.body.data.blockers.filter(x => x.code.startsWith('RULE_'))) {
    const effective_from = b.code === 'RULE_MID_PERIOD' ? `${year}-${String(month).padStart(2, '0')}-01` : b.effective_from;
    const res = await call(who, 'post', '/api/payroll/statutory-rules')
      .send({ rule_key: b.key, effective_from, value: b.value, source_reference: `Loan suite confirmation of ${b.code} ${b.key}` });
    if (res.status !== 201) throw new Error(`confirm ${b.key} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  const q = (sql) => pool.query(sql, [companyId]);
  await q(`DELETE FROM payslip_email_log WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_loan_repayments WHERE loan_id IN (SELECT id FROM payroll_loans WHERE employee_id IN ${emps})`);
  await q(`DELETE FROM payroll_loans WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_arrears WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM tds_transactions WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_runs WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM employee_salary_assignments WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE reference_type = 'salary_disbursement' AND split_part(reference_id, '-', 1)::int IN ${emps})`);
  await q(`DELETE FROM journal_entries WHERE reference_type = 'salary_disbursement' AND split_part(reference_id, '-', 1)::int IN ${emps}`);
  await q(`DELETE FROM journal_lines WHERE company_id = $1`);
  await q(`DELETE FROM journal_entries WHERE company_id = $1`);
  await q(`DELETE FROM payroll_statutory_rules WHERE company_id = $1`);
  await q(`DELETE FROM company_settings WHERE company_id = $1`);
  await q(`DELETE FROM salary_structures WHERE company_id = $1`);
  await q(`DELETE FROM employees WHERE company_id = $1`);
}

async function journalFor(tag) {
  const { rows } = await pool.query(
    `SELECT jl.account_code, SUM(jl.debit)::float AS d, SUM(jl.credit)::float AS c
       FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE je.company_id = $1 AND je.reference_type = 'payroll_run' AND je.reference_id LIKE $2
      GROUP BY jl.account_code`, [co.companyId, `${tag}:%`]);
  if (!rows.length) throw new Error(`no payroll journal for ${tag}`);
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    debit: r2(rows.reduce((t, r) => t + r.d, 0)), credit: r2(rows.reduce((t, r) => t + r.c, 0)),
    lines: Object.fromEntries(rows.map(r => [r.account_code, r2(r.c - r.d)])),
  };
}

async function addEmployee(code, basic) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, pan_number, account_number, ifsc_code, uan_number)
     VALUES ($1, $2, $2, 'Fixture', 'Active', '2026-04-01', 'ABCDE1234F', '123456789012', 'HDFC0001234', '100200300400') RETURNING id`,
    [co.companyId, code]);
  await pool.query(`INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from, basic_salary) VALUES ($1, NULL, '2026-04-01', $2)`, [r.id, basic]);
  return r.id;
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  checker = await addUser(pool, co);
  await pool.query(`UPDATE companies SET state = 'Karnataka', tan = 'BLRZ12345A' WHERE id = $1`, [co.companyId]);
  E.A = await addEmployee('EMP001', 30000);
  E.B = await addEmployee('EMP002', 30000);
  // a seed/demo loan: must never be listed, recovered or counted
  await pool.query(
    `INSERT INTO payroll_loans (employee_id, loan_type, principal_amount, emi_amount, outstanding_balance, start_date, status, is_test)
     VALUES ($1, 'Standard', 125000, 125000, 125000, '2026-06-01', 'active', true)`, [E.A]);
  const s = await call(co, 'post', '/api/settings/payroll').send({ statutory_state: 'Karnataka', pay_day_of_month: 25, payroll_cutoff_day: 20 });
  if (s.status !== 200) throw new Error(`settings: ${s.status} ${JSON.stringify(s.body)}`);
  // Loan batches need Finance-approved accounts (Part 14). These codes are a
  // FIXTURE for this throwaway company only — not a mapping for any real tenant.
  const finance = await addUser(pool, co, { label: 'finance', roleCode: 'finance' });
  const m = await call(finance, 'put', '/api/finance/accounting/loan-gl-mapping')
    .send({ receivable_account_code: '1013', interest_income_account_code: '4006' });
  if (m.status !== 200) throw new Error(`loan mapping: ${m.status} ${JSON.stringify(m.body)}`);
}, 60000);

afterAll(async () => {
  if (co) { await sweep(co.companyId); await dropIsolatedCompany(pool, co.companyId); }
}, 60000);

describe('loans & advances (isolated company, synthetic employees)', () => {
  it('refuses an EMI equal to the principal unless one installment is confirmed', async () => {
    const r = await call(co, 'post', '/api/payroll/loan-advances')
      .send({ employee_id: E.B, principal_amount: 20000, emi_amount: 20000, start_date: '2026-08-01' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('SINGLE_INSTALLMENT_CONFIRM');
    expect((await pool.query(`SELECT COUNT(*)::int n FROM payroll_loans WHERE employee_id = $1`, [E.B])).rows[0].n).toBe(0);
    const bad = await call(co, 'post', '/api/payroll/loan-advances')
      .send({ employee_id: E.B, loan_type: 'Standard', principal_amount: 20000, emi_amount: 2000, start_date: '2026-08-01' });
    expect(bad.status).toBe(400);
  });

  it('stores rate and tenure and builds the interest schedule', async () => {
    const r = await call(co, 'post', '/api/payroll/loan-advances')
      .send({ employee_id: E.A, loan_type: 'loan', principal_amount: 100000, interest_rate: 10, tenure_months: 12, start_date: '2026-08-01', reason: 'fixture' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ tenure_months: 12, remaining_installments: 12 });
    expect(Number(r.body.emi_amount)).toBe(8792);
    expect(Number(r.body.interest_rate)).toBe(10);
    expect(r.body.emi_schedule).toHaveLength(12);
    expect(r.body.total_interest).toBeGreaterThan(5400);
    loanId = r.body.id;
  });

  it('lists real loans only — the seed loan (EMI = principal) is not shown', async () => {
    const r = await call(co, 'get', '/api/payroll/loan-advances');
    expect(r.status).toBe(200);
    expect(r.body.map(l => l.id)).toEqual([loanId]);
    expect(r.body[0].next_installment).toEqual({ amount: 8792, interest: 833.33, principal: 7958.67, balance_after: 92041.33 });
  });

  it('the August draft deducts the installment (not the seed loan) and itemises every earning', async () => {
    const g = await call(co, 'post', '/api/payroll/generate').send({ month: 8, year: 2026 });
    expect(g.status).toBe(200);
    const a = (await call(co, 'get', `/api/payroll/payslips?employee_id=${E.A}&month=8&year=2026`)).body.data;
    expect(a).toMatchObject({ loan_deduction: 8792, advance_deduction: 0, gross: 75000 });
    expect(a.deductions.find(d => d.label === 'Loan EMI').amount).toBe(8792);
    expect(a.earnings.reduce((t, e) => t + e.amount, 0)).toBe(a.gross);
    expect(a.earning_lines.map(l => l.name)).toEqual(['Basic', 'HRA', 'Conveyance', 'Medical', 'Special Allowance']);
  });

  it('approval records the interest / principal split and reduces principal only', async () => {
    await confirmRules(co, 8, 2026);
    const ok = await call(checker, 'post', '/api/payroll/approve').send({ month: 8, year: 2026 });
    expect(ok.status).toBe(200);
    const { rows: [rep] } = await pool.query(`SELECT * FROM payroll_loan_repayments WHERE loan_id = $1`, [loanId]);
    expect(rep).toMatchObject({ source: 'payroll', month: 8, year: 2026 });
    expect(Number(rep.amount)).toBe(8792);
    expect(Number(rep.interest_component)).toBe(833.33);
    expect(Number(rep.principal_component)).toBe(7958.67);
    const { rows: [loan] } = await pool.query(`SELECT outstanding_balance, status FROM payroll_loans WHERE id = $1`, [loanId]);
    expect(Number(loan.outstanding_balance)).toBe(92041.33);
    const { rows: [seed] } = await pool.query(`SELECT outstanding_balance FROM payroll_loans WHERE employee_id = $1 AND is_test`, [E.A]);
    expect(Number(seed.outstanding_balance)).toBe(125000);
    // the GL entry balances: principal to the receivable, interest to income
    const gl = await journalFor('2026-08');
    expect(gl.debit).toBe(gl.credit);
    expect(gl.lines['1013']).toBe(7958.67);
    expect(gl.lines['4006']).toBe(833.33);
  });

  it('a prepayment that leaves the installment unchanged needs no regeneration; both rows sit in one month', async () => {
    await call(co, 'post', '/api/payroll/generate').send({ month: 9, year: 2026, employee_id: E.A });
    const pre = await call(co, 'post', `/api/payroll/loan-advances/${loanId}/prepay`).send({ amount: 50000, payment_date: '2026-09-10', reference: 'cheque 0001' });
    expect(pre.status).toBe(200);
    expect(Number(pre.body.loan.outstanding_balance)).toBe(42041.33);
    const over = await call(co, 'post', `/api/payroll/loan-advances/${loanId}/prepay`).send({ amount: 999999, payment_date: '2026-09-10' });
    expect(over.status).toBe(422);
    await confirmRules(co, 9, 2026);
    // EMI 8,792 is still below 42,041.33 + interest, so the draft's deduction stands
    const ok = await call(checker, 'post', '/api/payroll/approve').send({ month: 9, year: 2026 });
    expect(ok.status).toBe(200);
    const { rows } = await pool.query(`SELECT source, amount, interest_component, principal_component FROM payroll_loan_repayments WHERE loan_id = $1 AND month = 9 ORDER BY id`, [loanId]);
    expect(rows.map(r => r.source)).toEqual(['prepayment', 'payroll']);
    // interest is charged on the balance AFTER the prepayment: 42,041.33 × 10% / 12 = 350.34
    expect(Number(rows[1].interest_component)).toBe(350.34);
    expect(Number(rows[1].principal_component)).toBe(8441.66);
    const { rows: [loan] } = await pool.query(`SELECT outstanding_balance FROM payroll_loans WHERE id = $1`, [loanId]);
    expect(Number(loan.outstanding_balance)).toBe(33599.67);
  });

  it('a prepayment that changes the installment blocks approval until the draft is regenerated; the last installment closes the loan', async () => {
    await call(co, 'post', '/api/payroll/generate').send({ month: 10, year: 2026, employee_id: E.A });
    expect((await call(co, 'post', `/api/payroll/loan-advances/${loanId}/prepay`).send({ amount: 30000, payment_date: '2026-10-05' })).status).toBe(200);
    await confirmRules(co, 10, 2026);
    const stale = await call(checker, 'post', '/api/payroll/approve').send({ month: 10, year: 2026 });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toMatch(/Regenerate/);
    await call(co, 'post', '/api/payroll/generate').send({ month: 10, year: 2026, employee_id: E.A });
    const oct = (await call(co, 'get', `/api/payroll/payslips?employee_id=${E.A}&month=10&year=2026`)).body.data;
    // 3,599.67 + 30.00 interest = 3,629.67 → payslip shows 3,630
    expect(oct.loan_deduction).toBe(3630);
    expect((await call(checker, 'post', '/api/payroll/approve').send({ month: 10, year: 2026 })).status).toBe(200);
    const { rows: [loan] } = await pool.query(`SELECT outstanding_balance, status, closure_type FROM payroll_loans WHERE id = $1`, [loanId]);
    expect(loan).toMatchObject({ status: 'closed', closure_type: 'repaid' });
    expect(Number(loan.outstanding_balance)).toBe(0);
    const { rows: [last] } = await pool.query(`SELECT amount FROM payroll_loan_repayments WHERE loan_id = $1 AND month = 10 AND source = 'payroll'`, [loanId]);
    // the ledger records what the payslip deducted: 3,630, the 0.33 as interest
    expect(Number(last.amount)).toBe(3630);
    expect(Number(last.amount)).toBe(oct.loan_deduction);
  });

  it('close refuses a balance; a waiver needs a reason and is recorded', async () => {
    const c = await call(co, 'post', '/api/payroll/loan-advances')
      .send({ employee_id: E.B, loan_type: 'advance', principal_amount: 12000, emi_amount: 3000, start_date: '2026-11-01' });
    expect(c.status).toBe(201);
    const id = c.body.id;
    const r = await call(co, 'post', `/api/payroll/loan-advances/${id}/close`);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'LOAN_OUTSTANDING', outstanding: 12000 });
    expect((await pool.query(`SELECT status FROM payroll_loans WHERE id = $1`, [id])).rows[0].status).toBe('active');
    expect((await call(co, 'post', `/api/payroll/loan-advances/${id}/close`).send({ waive: true })).status).toBe(400);
    const w = await call(co, 'post', `/api/payroll/loan-advances/${id}/close`).send({ waive: true, reason: 'Management waiver, memo 7' });
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ closure_type: 'waived', waived_amount: 12000 });
    const { rows: [loan] } = await pool.query(`SELECT status, closure_type, closure_note, outstanding_balance FROM payroll_loans WHERE id = $1`, [id]);
    expect(loan).toMatchObject({ status: 'closed', closure_type: 'waived', closure_note: 'Management waiver, memo 7' });
    const { rows: [wv] } = await pool.query(`SELECT amount FROM payroll_loan_repayments WHERE loan_id = $1 AND source = 'waiver'`, [id]);
    expect(Number(wv.amount)).toBe(12000);
  });

  it('a structure component outside the five fixed columns is on the payslip', async () => {
    const st = await call(co, 'post', '/api/salary-structures').send({ name: 'Fixture with LTA', components: [
      { name: 'Basic', type: 'earning', calculation_type: 'percentage_of_ctc', value: 40 },
      { name: 'HRA', type: 'earning', calculation_type: 'percentage_of_basic', value: 40 },
      { name: 'LTA', type: 'earning', calculation_type: 'percentage_of_basic', value: 8.33 },
      { name: 'Special Allowance', type: 'earning', calculation_type: 'balancing', value: 0 },
    ] });
    expect(st.status).toBe(201);
    const as = await call(co, 'post', `/api/salary-structures/${st.body.id}/assign`).send({ employee_id: E.B, basic_salary: 30000, effective_from: '2026-10-01' });
    expect(as.status).toBe(201);
    await call(co, 'post', '/api/payroll/generate').send({ month: 10, year: 2026, employee_id: E.B });
    const b = (await call(co, 'get', `/api/payroll/payslips?employee_id=${E.B}&month=10&year=2026`)).body.data;
    expect(b.earnings.find(e => e.label === 'LTA')?.amount).toBe(2499);
    expect(b.earnings.reduce((t, e) => t + e.amount, 0)).toBe(b.gross);
  });

  it('the Payslip Generator shows an APPROVED month as approved — not recomputed from today\'s loan balance', async () => {
    // August was approved with an 8,792 EMI; the loan has since closed, so a
    // recomputation would show no EMI and a higher net pay.
    const r = await call(co, 'post', '/api/payroll/compute-slip').send({ employee_id: E.A, month: 8, year: 2026 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ source: 'approved_run', preview: false, run_status: 'approved', loan_deduction: 8792 });
    const pdf = await call(co, 'post', `/api/payroll/generate-pdf-data/${E.A}`).send({ month: 8, year: 2026 });
    expect(pdf.body).toMatchObject({ source: 'approved_run', watermark: null });
    expect(pdf.body.deductions.find(d => d.name === 'Loan EMI').monthly).toBe(8792);
    // a what-if on a finalised month is a preview, and says so on the PDF
    const wi = await call(co, 'post', `/api/payroll/generate-pdf-data/${E.A}`).send({ month: 8, year: 2026, lop_days: 1 });
    expect(wi.body).toMatchObject({ source: 'preview', watermark: 'WHAT-IF PREVIEW — NOT THE ISSUED PAYSLIP' });
  });
});

describe('representative loans through payroll: one deduction per month, approved once', () => {
  let adv, loan;
  const repayments = async (id) => (await pool.query(
    `SELECT month, year, source, amount::float, interest_component::float AS interest, principal_component::float AS principal, balance_after::float
       FROM payroll_loan_repayments WHERE loan_id = $1 ORDER BY year, month, id`, [id])).rows;
  const balance = async (id) => Number((await pool.query(`SELECT outstanding_balance FROM payroll_loans WHERE id = $1`, [id])).rows[0].outstanding_balance);

  beforeAll(async () => { E.C = await addEmployee('EMP003', 30000); });

  it('creates ₹60,000 / 12 months interest-free (advance) and at 12% (loan) with the closed-form EMIs', async () => {
    const a = await call(co, 'post', '/api/payroll/loan-advances')
      .send({ employee_id: E.C, loan_type: 'advance', principal_amount: 60000, tenure_months: 12, start_date: '2026-11-01', reason: 'fixture' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ loan_type: 'advance', tenure_months: 12, total_interest: 0, total_repayable: 60000 });
    expect(Number(a.body.emi_amount)).toBe(5000);
    expect(Number(a.body.interest_rate)).toBe(0);
    adv = a.body.id;
    const l = await call(co, 'post', '/api/payroll/loan-advances')
      .send({ employee_id: E.C, loan_type: 'loan', principal_amount: 60000, interest_rate: 12, tenure_months: 12, start_date: '2026-11-01' });
    expect(l.status).toBe(201);
    expect(Number(l.body.emi_amount)).toBe(5331);
    expect(l.body).toMatchObject({ tenure_months: 12, total_interest: 3972, total_repayable: 63972 });
    expect(l.body.emi_schedule.every(x => Number.isInteger(x.emi))).toBe(true);
    expect(l.body.next_installment).toEqual({ amount: 5331, interest: 600, principal: 4731, balance_after: 55269 });
    loan = l.body.id;
  });

  it('refuses invalid input and writes nothing', async () => {
    const before = (await pool.query(`SELECT COUNT(*)::int n FROM payroll_loans WHERE employee_id = $1`, [E.C])).rows[0].n;
    for (const [body, code] of [
      [{ principal_amount: -60000, tenure_months: 12 }, 'PRINCIPAL'],
      [{ principal_amount: 60000, tenure_months: 0 }, 'TENURE'],
      [{ principal_amount: 60000, tenure_months: 2.5 }, 'TENURE'],
      [{ principal_amount: 60000, tenure_months: 12, interest_rate: -2 }, 'INTEREST_RATE'],
      [{ principal_amount: 60000, emi_amount: 3333.33 }, 'EMI'],
    ]) {
      const r = await call(co, 'post', '/api/payroll/loan-advances').send({ employee_id: E.C, start_date: '2026-11-01', ...body });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe(code);
    }
    expect((await call(co, 'post', '/api/payroll/loan-advances').send({ principal_amount: 60000, tenure_months: 12, start_date: '2026-11-01' })).status).toBe(400);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM payroll_loans WHERE employee_id = $1`, [E.C])).rows[0].n).toBe(before);
  });

  it('a draft rerun replaces the draft — still one row, one deduction each', async () => {
    for (let i = 0; i < 2; i++) expect((await call(co, 'post', '/api/payroll/generate').send({ month: 11, year: 2026, employee_id: E.C })).status).toBe(200);
    const { rows } = await pool.query(`SELECT loan_deduction::float, advance_deduction::float, status FROM payroll_runs WHERE employee_id = $1 AND month = 11 AND year = 2026`, [E.C]);
    expect(rows).toEqual([{ loan_deduction: 5331, advance_deduction: 5000, status: 'pending' }]);
    // a draft changes no balance and records no repayment
    expect(await repayments(loan)).toEqual([]);
    expect(await balance(loan)).toBe(60000);
  });

  it('maker-checker holds; approval records each installment once and reduces the balance', async () => {
    await confirmRules(co, 11, 2026);
    const own = await call(co, 'post', '/api/payroll/approve').send({ month: 11, year: 2026 });
    expect(own.status).toBe(403);
    expect(await repayments(loan)).toEqual([]);
    const ok = await call(checker, 'post', '/api/payroll/approve').send({ month: 11, year: 2026 });
    expect(ok.status).toBe(200);
    expect(await repayments(adv)).toEqual([{ month: 11, year: 2026, source: 'payroll', amount: 5000, interest: 0, principal: 5000, balance_after: 55000 }]);
    expect(await repayments(loan)).toEqual([{ month: 11, year: 2026, source: 'payroll', amount: 5331, interest: 600, principal: 4731, balance_after: 55269 }]);
    expect(await balance(adv)).toBe(55000);
    expect(await balance(loan)).toBe(55269);
    const gl = await journalFor('2026-11');
    expect(gl.debit).toBe(gl.credit);
    // principal 4,731 (loan) + 5,000 (advance); interest 600 — from the repayment rows
    expect(gl.lines['1013']).toBe(9731);
    expect(gl.lines['4006']).toBe(600);
  });

  it('approving again, or regenerating the approved month, deducts nothing more', async () => {
    expect((await call(checker, 'post', '/api/payroll/approve').send({ month: 11, year: 2026 })).status).toBe(400);
    await call(co, 'post', '/api/payroll/generate').send({ month: 11, year: 2026, employee_id: E.C });
    const { rows } = await pool.query(`SELECT loan_deduction::float, advance_deduction::float, status FROM payroll_runs WHERE employee_id = $1 AND month = 11 AND year = 2026`, [E.C]);
    expect(rows).toEqual([{ loan_deduction: 5331, advance_deduction: 5000, status: 'approved' }]);
    expect((await repayments(loan)).length).toBe(1);
    expect((await repayments(adv)).length).toBe(1);
    expect(await balance(loan)).toBe(55269);
    expect(await balance(adv)).toBe(55000);
  });

  it('a draft made before seed loans were excluded (it deducted the seed loan) is refused at approval', async () => {
    // Manifest's September 2026 drafts are in this state: generated 30 Sep,
    // deducting the full is_test seed loan. Approval must not let them through.
    await call(co, 'post', '/api/payroll/generate').send({ month: 12, year: 2026, employee_id: E.A });
    await call(co, 'post', '/api/payroll/generate').send({ month: 12, year: 2026, employee_id: E.C });
    await pool.query(`UPDATE payroll_runs SET loan_deduction = 125000 WHERE employee_id = $1 AND month = 12 AND year = 2026`, [E.A]);
    await confirmRules(co, 12, 2026);
    const stale = await call(checker, 'post', '/api/payroll/approve').send({ month: 12, year: 2026 });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toMatch(/Regenerate/);
    // the whole batch rolled back: nothing recorded for E.C either, seed untouched
    expect((await repayments(loan)).length).toBe(1);
    const { rows: [seed] } = await pool.query(`SELECT outstanding_balance::float AS b FROM payroll_loans WHERE employee_id = $1 AND is_test`, [E.A]);
    expect(seed.b).toBe(125000);
    // regenerating clears it; December then recovers the second installment once
    await call(co, 'post', '/api/payroll/generate').send({ month: 12, year: 2026, employee_id: E.A });
    expect((await call(checker, 'post', '/api/payroll/approve').send({ month: 12, year: 2026 })).status).toBe(200);
    // month 2 at 12%: 55,269 × 1% = 552.69 interest; 4,778.31 principal; 50,490.69 left
    expect((await repayments(loan))[1]).toEqual({ month: 12, year: 2026, source: 'payroll', amount: 5331, interest: 552.69, principal: 4778.31, balance_after: 50490.69 });
    expect(await balance(loan)).toBe(50490.69);
    expect(await balance(adv)).toBe(50000);
  });

  it('a part-prepayment must be whole rupees; the full outstanding may carry paise', async () => {
    const bad = await call(co, 'post', `/api/payroll/loan-advances/${adv}/prepay`).send({ amount: 100.5, payment_date: '2027-01-05' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('PREPAY_WHOLE_RUPEES');
    const full = await call(co, 'post', `/api/payroll/loan-advances/${loan}/prepay`).send({ amount: 50490.69, payment_date: '2027-01-05', reference: 'fixture settle' });
    expect(full.status).toBe(200);
    expect(full.body.loan).toMatchObject({ status: 'closed', closure_type: 'prepaid' });
  });
});
