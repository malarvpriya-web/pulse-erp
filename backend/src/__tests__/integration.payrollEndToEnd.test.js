/**
 * End-to-end payroll — PAYROLL_DATA_FLOW_AUDIT.md (2026-10-20).
 *
 * Employee → salary revision → eligibility → monthly run (with arrears and a
 * loan EMI) → approval (blocked by bad bank data, then allowed) → loan
 * repayment → payment → Form 138 validation → Form 16 lifecycle, through the
 * real routers against the real database, in a throwaway company with
 * synthetic employees only. No real employee's data is read or written.
 *
 * Expected figures are worked by hand in the comments so a change in the engine
 * shows up as a changed number, not just "still truthy".
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
delete process.env.EMPLOYER_TAN;

const { default: pool }          = await import('../config/db.js');
const { verifyToken }            = await import('../middlewares/auth.middleware.js');
const { buildApp }               = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { default: payrollRoutes } = await import('../modules/payroll/payroll.routes.js');
const { default: salaryRoutes }  = await import('../modules/payroll/salaryStructure.routes.js');
const { default: tdsRoutes }     = await import('../modules/finance/tds.routes.js');
const { default: settingsRoutes } = await import('../modules/admin/settings-status.routes.js');
const { auditMutations }         = await import('../middlewares/auditMutations.js');
const { default: incrementRoutes } = await import('../modules/performance/routes/increments.routes.js');

const app = buildApp(
  ['/api/payroll', verifyToken, payrollRoutes],
  ['/api/salary-structures', verifyToken, salaryRoutes],
  ['/api/tds', verifyToken, tdsRoutes],
  ['/api/settings', verifyToken, auditMutations('settings'), settingsRoutes],
  ['/api/performance/increments', verifyToken, incrementRoutes],
);

const PREFIX = 'ZZPAYAUD';
let co, other, checker, otherChecker;   // checker = a DIFFERENT user who approves (maker-checker)
let payer;   // PC-01 D2/Q1: payment is finance_manager only, and never the run's preparer (`co`)
// PC-02a PD-1: a payment carries the bank reference (UTR) and the value date (today, IST).
const paidWith = (reference) => ({ month: 8, year: 2026, reference, value_date: new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10) });
const E = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);

/**
 * Clear the RULE_* release blockers for a month the way an authorised user
 * would: record a company version of each named rule, with its value unchanged
 * and a source reference. Returns the blockers that were cleared.
 */
async function confirmRules(who, month, year) {
  const r = await call(who, 'get', `/api/payroll/release-readiness?month=${month}&year=${year}`);
  const rules = r.body.data.blockers.filter(b => b.code.startsWith('RULE_'));
  for (const b of rules) {
    const effective_from = b.code === 'RULE_MID_PERIOD' ? `${year}-${String(month).padStart(2, '0')}-01` : b.effective_from;
    const res = await call(who, 'post', '/api/payroll/statutory-rules')
      .send({ rule_key: b.key, effective_from, value: b.value, source_reference: `E2E confirmation of ${b.code} ${b.key}` });
    if (res.status !== 201) throw new Error(`confirm ${b.key} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return rules;
}

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  const q = (sql) => pool.query(sql, [companyId]).catch(e => { throw new Error(`${sql.slice(0, 60)}: ${e.message}`); });
  await q(`DELETE FROM increment_recommendations WHERE company_id = $1 OR employee_id IN ${emps}`);
  await q(`DELETE FROM payslip_email_log WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_loan_repayments WHERE loan_id IN (SELECT id FROM payroll_loans WHERE employee_id IN ${emps})`);
  await q(`DELETE FROM payroll_loans WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_arrears WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM tds_transactions WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM tds_deductees WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_runs WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM employee_salary_assignments WHERE employee_id IN ${emps}`);
  // salary_disbursement entries are keyed '<employeeId>-<yyyy>-<mm>'; older code wrote them
  // with company_id NULL, so match them by employee as well as by company.
  await q(`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE reference_type = 'salary_disbursement' AND split_part(reference_id, '-', 1)::int IN ${emps})`);
  await q(`DELETE FROM journal_entries WHERE reference_type = 'salary_disbursement' AND split_part(reference_id, '-', 1)::int IN ${emps}`);
  await q(`DELETE FROM journal_lines WHERE company_id = $1`);
  await q(`DELETE FROM journal_entries WHERE company_id = $1`);
  await q(`DELETE FROM payroll_statutory_rules WHERE company_id = $1`);
  await q(`DELETE FROM company_settings WHERE company_id = $1`);
  await q(`DELETE FROM employees WHERE company_id = $1`);
  await q(`DELETE FROM offer_letters WHERE company_id = $1`);
  await q(`DELETE FROM candidates WHERE company_id = $1`);
}

async function addEmployee(code, fields, revision, company = co) {
  const f = {
    first_name: code, last_name: 'Fixture', status: 'Active', joining_date: '2026-04-01',
    pan_number: 'ABCDE1234F', account_number: '123456789012', ifsc_code: 'HDFC0001234', uan_number: '100200300400',
    ...fields,
  };
  const cols = Object.keys(f);
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, ${cols.join(', ')})
     VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
    [company.companyId, code, ...cols.map(c => f[c])]);
  if (revision) {
    // structure_id NULL → the company default structure (the live "Standard
    // Structure": Basic 40% of CTC, HRA 40% of Basic, ₹1,600, ₹1,250, balancing).
    await pool.query(
      `INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from, basic_salary)
       VALUES ($1, NULL, $2, $3)`, [r.id, revision.from, revision.basic]);
  }
  return r.id;
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  checker = await addUser(pool, co);
  otherChecker = await addUser(pool, other);
  payer = await addUser(pool, co, { label: 'payer', roleCode: 'finance_manager' });
  await pool.query(`UPDATE companies SET state = 'Karnataka', tan = 'BLRZ12345A' WHERE id = $1`, [co.companyId]);
  E.A = await addEmployee('EMP001', {}, { from: '2026-04-01', basic: 30000 });
  E.B = await addEmployee('EMP002', { basic_salary: 50000 }, null);             // master basic, no revision
  E.C = await addEmployee('EMP003', { status: 'Left', exit_date: '2026-06-30' }, { from: '2026-04-01', basic: 40000 });
  E.D = await addEmployee('EMP004', { joining_date: '2026-08-21', pan_number: 'BADPAN' }, { from: '2026-08-21', basic: 20000 });
  E.E = await addEmployee('EMP005', { ifsc_code: '1231' }, { from: '2026-04-01', basic: 100000 });
  await pool.query(
    `INSERT INTO payroll_loans (employee_id, loan_type, principal_amount, emi_amount, outstanding_balance, start_date, status)
     VALUES ($1, 'loan', 12000, 5000, 12000, '2026-08-01', 'active')`, [E.A]);
  // Approval refuses a loan batch until Finance has mapped its accounts
  // (PAYROLL_DATA_FLOW_AUDIT.md Part 14). Fixture codes, this test company only.
  const { setLoanGlMapping } = await import('../modules/finance/services/loanGlMapping.service.js');
  await setLoanGlMapping(co.companyId, { receivable_account_code: '1013', interest_income_account_code: '4006' }, checker.userId);
}, 60000);

afterAll(async () => {
  for (const c of [co, other]) if (c) { await sweep(c.companyId); await dropIsolatedCompany(pool, c.companyId); }
}, 60000);

describe('payroll end to end (isolated company, synthetic employees)', () => {
  let arrearId;

  it('eligibility has one answer, with reasons', async () => {
    const r = await call(co, 'get', '/api/payroll/eligibility?month=8&year=2026');
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.data.employees.map(e => [e.employee_code, e]));
    expect(by.EMP001.eligible).toBe(true);
    expect(by.EMP002.eligible).toBe(false);
    expect(by.EMP002.reasons[0]).toMatchObject({ code: 'E5' });
    expect(by.EMP002.reasons[0].message).toMatch(/Employee master shows Basic ₹50,000/);
    expect(by.EMP003.reasons.map(x => x.code)).toContain('E2');
    expect(r.body.data.summary).toMatchObject({ active_headcount: 4, eligible: 3, not_eligible: 1 });
  });

  it('Salary Structure lists employees WITHOUT a revision too, with the engine gross', async () => {
    const r = await call(co, 'get', '/api/salary-structures/assignments');
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.map(a => [a.employee_code, a]));
    expect(by.EMP002).toMatchObject({ has_revision: false });
    expect(by.EMP001.gross_estimate).toBe(75000);      // not 30,000 × 1.4167 = 42,501
  });

  it('an implausible monthly Basic must be confirmed', async () => {
    const r = await call(co, 'post', '/api/salary-structures/1/assign').send({ employee_id: E.B, basic_salary: 750000, effective_from: '2026-10-01' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('CONFIRM_HIGH_BASIC');
  });

  it('arrears are computed by the engine, month by month', async () => {
    // 28,000 → 30,000 for Apr–Jul: gross 70,000 → 75,000 = 5,000 × 4 = 20,000.
    // PF wage is above the ₹15,000 ceiling both ways, so no PF differential.
    const pv = await call(co, 'get', `/api/payroll/arrears/compute?employee_id=${E.A}&from_month=4&from_year=2026&to_month=7&to_year=2026&old_basic=28000&new_basic=30000`);
    expect(pv.status).toBe(200);
    expect(pv.body).toMatchObject({ months_count: 4, total_arrear: 20000, employee_pf_diff: 0 });
    const cr = await call(co, 'post', '/api/payroll/arrears').send({ employee_id: E.A, from_month: 4, from_year: 2026, to_month: 7, to_year: 2026, old_basic: 28000, new_basic: 30000, arrear_amount: 999999 });
    expect(cr.status).toBe(201);
    expect(Number(cr.body.arrear_amount)).toBe(20000);  // client figure ignored
    arrearId = cr.body.id;
    const ap = await call(co, 'put', `/api/payroll/arrears/${arrearId}/approve`).send({ paid_in_month: 8, paid_in_year: 2026 });
    expect(ap.status).toBe(200);
  });

  it('generates August for eligible employees only, with arrears and the EMI', async () => {
    const r = await call(co, 'post', '/api/payroll/generate').send({ month: 8, year: 2026 });
    expect(r.status).toBe(200);
    expect(r.body.data.count).toBe(3);
    expect(r.body.data.skipped.map(s => s.employee_code)).toEqual(['EMP002']);
    const a = (await call(co, 'get', `/api/payroll/payslips?employee_id=${E.A}&month=8&year=2026`)).body.data;
    // 75,000 regular + 20,000 arrears = 95,000. Deductions: PF 12% × 15,000 =
    // 1,800 (Aug: old ceiling), PT 200 (KA, default settings), EMI 5,000, TDS 0
    // (projected ₹6.2 L < ₹12 L rebate limit) → net 88,000.
    expect(a).toMatchObject({ employee_code: 'EMP001', status: 'pending', gross: 95000, arrears: 20000,
      employee_pf: 1800, professional_tax: 200, loan_deduction: 5000, tds: 0, total_deductions: 7000, net_pay: 88000 });
    expect(a.employer_contributions).toMatchObject({ pf_total: 1800, eps: 1250, epf: 550 });
    expect(a.deductions.map(d => d.label).join('|')).not.toMatch(/Employer/);
    expect(a.employer_contributions_list.map(c => c.label).join('|')).toMatch(/EPS/);
    expect(a.deductions.reduce((s, d) => s + d.amount, 0)).toBe(a.total_deductions);
    const d = (await call(co, 'get', `/api/payroll/payslips?employee_id=${E.D}&month=8&year=2026`)).body.data;
    expect(d.basic).toBe(Math.round(20000 * 11 / 31));   // joined 21 Aug
    const e = (await call(co, 'get', `/api/payroll/payslips?employee_id=${E.E}&month=8&year=2026`)).body.data;
    // 2,50,000 × 8 remaining months = 20,00,000 − 75,000 = 19,25,000 →
    // 20,000 + 40,000 + 60,000 + 65,000 = 1,85,000 × 1.04 = 1,92,400 / 8.
    expect(e.tds).toBe(24050);
    expect(e.validation_issues.some(i => i.field === 'ifsc_code' && i.severity === 'error')).toBe(true);
  });

  it('Mark Paid refuses a draft — payment needs approval', async () => {
    const r = await call(payer, 'post', `/api/payroll/${E.A}/mark-paid`).send(paidWith('E2EUTRA0000001'));
    expect(r.status).toBe(409);
  });

  it('approval is gated on unverified statutory rules and undecided choices', async () => {
    const gated = await call(co, 'post', '/api/payroll/approve').send({ month: 8, year: 2026 });
    expect(gated.status).toBe(422);
    const codes = new Set(gated.body.release_blockers.map(b => b.code));
    expect(codes.has('RULE_UNVERIFIED')).toBe(true);
    expect(codes.has('RULE_DECISION')).toBe(true);
    // the statutory jurisdiction is not recorded (Part 7)
    expect(codes.has('JURISDICTION_UNCONFIRMED')).toBe(true);
    // nothing was approved by the refused attempt
    const { rows: [n] } = await pool.query(`SELECT COUNT(*)::int n FROM payroll_runs WHERE employee_id = ANY($1) AND status <> 'pending'`, [[E.A, E.D, E.E]]);
    expect(n.n).toBe(0);
    const cleared = await confirmRules(co, 8, 2026);
    expect(cleared.length).toBeGreaterThan(0);
    // recording a state the employees do not resolve to is refused by the gate
    await call(co, 'post', '/api/settings/payroll').send({ statutory_state: 'Tamil Nadu', pay_day_of_month: 25, payroll_cutoff_day: 20 });
    const wrong = (await call(co, 'get', '/api/payroll/release-readiness?month=8&year=2026')).body.data.blockers.map(b => b.code);
    expect(wrong).toEqual(expect.arrayContaining(['JURISDICTION_MISMATCH', 'PT_LOCAL_BODY']));
    expect((await call(co, 'post', '/api/settings/payroll').send({ statutory_state: 'Karnataka', pay_day_of_month: 25, payroll_cutoff_day: 20 })).status).toBe(200);
    const after = await call(co, 'get', '/api/payroll/release-readiness?month=8&year=2026');
    expect(after.body.data).toMatchObject({ ready: true, blockers: [] });
    // confirming the values in force changed no figure
    const a = (await call(co, 'get', `/api/payroll/payslips?employee_id=${E.A}&month=8&year=2026`)).body.data;
    expect(a).toMatchObject({ gross: 95000, net_pay: 88000 });
  });

  it('maker-checker: the preparer cannot approve their own drafts, even holding HR and Finance (admin) rights', async () => {
    const own = await call(co, 'post', '/api/payroll/approve').send({ month: 8, year: 2026 });
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('MAKER_CHECKER');
    const { rows: [n] } = await pool.query(`SELECT COUNT(*)::int n FROM payroll_runs WHERE employee_id = ANY($1) AND status <> 'pending'`, [[E.A, E.D, E.E]]);
    expect(n.n).toBe(0);
  });

  it('maker-checker: a draft with no recorded preparer is refused until regenerated', async () => {
    const { rows: [r] } = await pool.query(`UPDATE payroll_runs SET generated_by = NULL WHERE employee_id = $1 AND month = 8 AND year = 2026 RETURNING id`, [E.A]);
    const res = await call(checker, 'post', '/api/payroll/approve').send({ month: 8, year: 2026 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PREPARER_UNKNOWN');
    await pool.query(`UPDATE payroll_runs SET generated_by = $2 WHERE id = $1`, [r.id, co.adminId]);
  });

  it('approval is blocked by invalid bank data, then succeeds once it is fixed', async () => {
    const blocked = await call(checker, 'post', '/api/payroll/approve').send({ month: 8, year: 2026 });
    expect(blocked.status).toBe(422);
    expect(blocked.body.blocked.map(b => b.employee_code)).toEqual(['EMP005']);
    await pool.query(`UPDATE employees SET ifsc_code = 'HDFC0001234' WHERE id = $1`, [E.E]);
    const ok = await call(checker, 'post', '/api/payroll/approve').send({ month: 8, year: 2026 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ approved_count: 3, loan_repayments: 1 });
    const { rows: [loan] } = await pool.query(`SELECT outstanding_balance, status FROM payroll_loans WHERE employee_id = $1`, [E.A]);
    expect(Number(loan.outstanding_balance)).toBe(7000);
    const { rows: [arr] } = await pool.query(`SELECT status, paid_run_id FROM payroll_arrears WHERE id = $1`, [arrearId]);
    expect(arr.status).toBe('paid');
    expect(arr.paid_run_id).not.toBeNull();
  });

  it('an approved run cannot be regenerated or overwritten by the Payslip Generator', async () => {
    const regen = await call(co, 'post', '/api/payroll/generate').send({ month: 8, year: 2026 });
    expect(regen.body.data.count).toBe(0);
    const save = await call(co, 'post', '/api/payroll/save-slip').send({ employee_id: E.A, month: 8, year: 2026, bonus: 50000 });
    expect(save.body.count).toBe(0);
    const { rows: [r] } = await pool.query(`SELECT gross, status FROM payroll_runs WHERE employee_id = $1 AND month = 8 AND year = 2026`, [E.A]);
    expect(Number(r.gross)).toBe(95000);
    expect(r.status).toBe('approved');
  });

  it('the Payslip Generator previews with the official inputs and writes nothing', async () => {
    const before = (await pool.query(`SELECT COUNT(*)::int n FROM payroll_runs WHERE employee_id = $1`, [E.A])).rows[0].n;
    const r = await call(co, 'post', '/api/payroll/compute-slip').send({ employee_id: E.A, month: 9, year: 2026 });
    expect(r.status).toBe(200);
    expect(r.body.preview).toBe(true);
    // September: ₹25,000 ceiling → PF 3,000; EMI min(5,000, 7,000 outstanding).
    expect(r.body).toMatchObject({ gross: 75000, employee_pf: 3000, loan_deduction: 5000 });
    const ne = await call(co, 'post', '/api/payroll/compute-slip').send({ employee_id: E.B, month: 9, year: 2026 });
    expect(ne.status).toBe(422);
    const after = (await pool.query(`SELECT COUNT(*)::int n FROM payroll_runs WHERE employee_id = $1`, [E.A])).rows[0].n;
    expect(after).toBe(before);
  });

  it('pays an approved payslip; email is refused for a draft', async () => {
    const paid = await call(payer, 'post', `/api/payroll/${E.A}/mark-paid`).send(paidWith('E2EUTRA0000001'));
    expect(paid.status).toBe(200);
    await call(co, 'post', '/api/payroll/generate').send({ month: 9, year: 2026, employee_id: E.A });
    const mail = await call(co, 'post', '/api/payroll/email-payslip').send({ employee_id: E.A, month: 9, year: 2026 });
    expect(mail.status).toBe(409);
  });

  it('Form 138 (formerly 24Q) validates before it generates', async () => {
    const r = await call(co, 'get', '/api/tds/form24q?financial_year=2026-27&quarter=Q2');
    expect(r.status).toBe(200);
    expect(r.body.form_label).toBe('Form 138 (formerly Form 24Q)');
    const codes = r.body.validation.errors.map(e => e.code);
    expect(codes).toContain('UNAPPROVED');   // September draft for EMP001
    expect(codes).toContain('PAN');          // EMP004 'BADPAN'
    expect(codes).toContain('CHALLAN');      // EMP005 TDS with no challan
    expect(codes).not.toContain('TAN');
    const dl = await call(co, 'get', '/api/tds/form24q-download?financial_year=2026-27&quarter=Q2');
    expect(dl.status).toBe(422);
  });

  it('the loan closes itself when the last instalment is approved', async () => {
    const sep = await call(co, 'get', '/api/payroll/release-readiness?month=9&year=2026');
    const mid = sep.body.data.blockers.find(b => b.code === 'RULE_MID_PERIOD');
    expect(mid).toMatchObject({ key: 'pf.wage_ceiling', changed_on: '2026-09-17', value: 25000 });
    expect((await call(checker, 'post', '/api/payroll/approve').send({ month: 9, year: 2026 })).status).toBe(422);
    await confirmRules(co, 9, 2026);
    expect((await call(checker, 'post', '/api/payroll/approve').send({ month: 9, year: 2026 })).status).toBe(200);  // 7,000 → 2,000
    await call(co, 'post', '/api/payroll/generate').send({ month: 10, year: 2026, employee_id: E.A });
    const oct = (await call(co, 'get', `/api/payroll/payslips?employee_id=${E.A}&month=10&year=2026`)).body.data;
    expect(oct.loan_deduction).toBe(2000);   // never more than what is owed
    await confirmRules(co, 10, 2026);
    expect((await call(checker, 'post', '/api/payroll/approve').send({ month: 10, year: 2026 })).status).toBe(200);
    const { rows: [loan] } = await pool.query(`SELECT outstanding_balance, status FROM payroll_loans WHERE employee_id = $1`, [E.A]);
    expect(loan).toMatchObject({ status: 'closed' });
    expect(Number(loan.outstanding_balance)).toBe(0);
    const reps = (await pool.query(`SELECT COUNT(*)::int n FROM payroll_loan_repayments r JOIN payroll_loans l ON l.id = r.loan_id WHERE l.employee_id = $1`, [E.A])).rows[0].n;
    expect(reps).toBe(3);
  });

  it('Form 16 is in progress until FY 2026-27 ends, and cannot be downloaded', async () => {
    const st = await call(co, 'get', '/api/payroll/form16-status?financial_year=2026-2027');
    expect(st.status).toBe(200);
    const a = st.body.data.employees.find(e => e.employee_code === 'EMP001');
    expect(a).toMatchObject({ status: 'in_progress', can_generate: false });
    const pdf = await call(co, 'get', `/api/payroll/form16/${E.A}/pdf?financial_year=2026-2027`);
    expect(pdf.status).toBe(409);
    const f16 = await call(co, 'get', `/api/payroll/form16/${E.A}?financial_year=2026-2027`);
    expect(f16.body.data.months_included).toBe(3);   // Aug, Sep, Oct — finalised only
  });

  it('reruns duplicate nothing: approval, loan repayments, payment, TDS ledger, GL', async () => {
    const count = async (sql, p) => (await pool.query(sql, p)).rows[0].n;
    const reps = () => count(`SELECT COUNT(*)::int n FROM payroll_loan_repayments r JOIN payroll_loans l ON l.id = r.loan_id WHERE l.employee_id = $1`, [E.A]);
    const gl = () => count(`SELECT COUNT(*)::int n FROM journal_entries WHERE company_id = $1 AND reference_type = 'payroll_run'`, [co.companyId]);
    const tds = () => count(`SELECT COUNT(*)::int n FROM tds_transactions WHERE employee_id = $1 AND payroll_month = 8 AND payroll_year = 2026 AND section = '192'`, [E.E]);
    const before = { reps: await reps(), gl: await gl() };
    expect((await call(checker, 'post', '/api/payroll/approve').send({ month: 8, year: 2026 })).status).toBe(400);
    expect(await reps()).toBe(before.reps);
    expect(await gl()).toBe(before.gl);
    // one GL journal per approval batch: Aug, Sep, Oct
    const { rows: refs } = await pool.query(`SELECT reference_id FROM journal_entries WHERE company_id = $1 AND reference_type = 'payroll_run' ORDER BY reference_id`, [co.companyId]);
    expect(refs.map(r => r.reference_id.slice(0, 7))).toEqual(['2026-08', '2026-09', '2026-10']);
    // payment of EMP005 (TDS ₹24,050) twice → one paid row, one s.192 ledger row with the company
    expect((await call(payer, 'post', `/api/payroll/${E.E}/mark-paid`).send(paidWith('E2EUTRE0000001'))).status).toBe(200);
    const again = await call(payer, 'post', `/api/payroll/${E.E}/mark-paid`).send(paidWith('E2EUTRE0000001'));
    expect(again.body.message).toMatch(/Already/);
    expect(await tds()).toBe(1);
    const { rows: [t] } = await pool.query(`SELECT total_tds, company_id, quarter, financial_year FROM tds_transactions WHERE employee_id = $1 AND payroll_month = 8`, [E.E]);
    expect(t).toMatchObject({ company_id: co.companyId, quarter: 'Q2', financial_year: '2026-2027' });
    expect(Number(t.total_tds)).toBe(24050);
  });

  it('arrears are paid exactly once', async () => {
    const sep = (await call(co, 'get', `/api/payroll/payslips?employee_id=${E.A}&month=9&year=2026`)).body.data;
    expect(sep.arrears).toBe(0);
    const { rows } = await pool.query(`SELECT pr.month FROM payroll_runs pr WHERE pr.employee_id = $1 AND pr.arrears_amount > 0`, [E.A]);
    expect(rows.map(r => r.month)).toEqual([8]);
  });

  it('PF ECR: EPFO layout from approved payroll, contribution wage capped by the month\'s ceiling', async () => {
    const r = await call(co, 'get', '/api/payroll/pf-ecr?month=8&year=2026');
    expect(r.status).toBe(200);
    const lines = r.text.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l.split('#~#')).toHaveLength(11);
    const a = lines.map(l => l.split('#~#')).find(x => x[1] === 'EMP001 FIXTURE');
    // UAN, name, gross 95,000, EPF/EPS/EDLI wages 15,000 (Aug ceiling), 1,800 / 1,250 / 550, NCP 0, refund 0
    expect(a).toEqual(['100200300400', 'EMP001 FIXTURE', '95000', '15000', '15000', '15000', '1800', '1250', '550', '0', '0']);
  });

  it('GL posts for every company, not only the first to post a month', async () => {
    const X = await addEmployee('EMP001', {}, { from: '2026-04-01', basic: 30000 }, other);
    const g = await call(other, 'post', '/api/payroll/generate').send({ month: 8, year: 2026 });
    expect(g.body.data.count).toBe(1);
    await confirmRules(other, 8, 2026);
    // a company with no state: its employee resolves to none, so even a recorded jurisdiction blocks
    await call(other, 'post', '/api/settings/payroll').send({ statutory_state: 'Karnataka', pay_day_of_month: 25, payroll_cutoff_day: 20 });
    const noState = await call(otherChecker, 'post', '/api/payroll/approve').send({ month: 8, year: 2026 });
    expect(noState.status).toBe(422);
    expect(noState.body.release_blockers.map(b => b.code)).toContain('JURISDICTION_MISMATCH');
    await pool.query(`UPDATE companies SET state = 'Karnataka' WHERE id = $1`, [other.companyId]);
    const ap = await call(otherChecker, 'post', '/api/payroll/approve').send({ month: 8, year: 2026 });
    expect(ap.status).toBe(200);
    const { rows } = await pool.query(`SELECT company_id FROM journal_entries WHERE reference_type = 'payroll_run' AND reference_id LIKE '2026-08:%' AND company_id = ANY($1)`, [[co.companyId, other.companyId]]);
    expect(rows.map(r => r.company_id).sort()).toEqual([co.companyId, other.companyId].sort());
    await pool.query(`DELETE FROM payroll_runs WHERE employee_id = $1`, [X]);
  });

  it('payroll settings: an invalid cycle is refused; a save writes one value to both key families and is audited with its before-image', async () => {
    const bad = await call(other, 'post', '/api/settings/payroll').send({ pay_day_of_month: 25, payroll_cutoff_day: 29 });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/Cutoff day \(29\) must be before pay day \(25\)/);
    expect((await call(other, 'post', '/api/settings/payroll').send({ pay_day_of_month: 25, payroll_cutoff_day: 20, professional_tax: false })).status).toBe(200);
    const ok = await call(other, 'post', '/api/settings/payroll').send({ pay_day_of_month: 25, payroll_cutoff_day: 20, professional_tax: true });
    expect(ok.status).toBe(200);
    const { rows: [st] } = await pool.query(
      `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'payroll'`, [other.companyId]);
    expect(st.settings).toMatchObject({ professional_tax: true, pt: { enabled: true }, pay_day_of_month: 25, pay_day: 25, payroll_cutoff_day: 20, cutoff_day: 20 });
    await new Promise(r => { setTimeout(r, 300); });   // logAudit is fire-and-forget
    const { rows } = await pool.query(
      `SELECT old_data_json FROM audit_logs WHERE company_id = $1 AND module_name = 'settings' ORDER BY id DESC LIMIT 1`, [other.companyId]);
    expect(rows[0]?.old_data_json).toMatchObject({ professional_tax: false });
  });

  it('salary-disbursement journal carries its company and is written once', async () => {
    const { rows } = await pool.query(
      "SELECT company_id FROM journal_entries WHERE reference_type = 'salary_disbursement' AND reference_id = $1", [E.E + '-2026-08']);
    expect(rows).toHaveLength(1);
    expect(rows[0].company_id).toBe(co.companyId);
  });

  it('a salary revision effective mid-month blocks approval until its treatment is decided', async () => {
    await pool.query("INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from, basic_salary) VALUES ($1, NULL, '2026-11-15', 32000)", [E.A]);
    const g = await call(co, 'post', '/api/payroll/generate').send({ month: 11, year: 2026, employee_id: E.A });
    expect(g.body.data.data[0].validation_issues.map(i => i.code)).toContain('REVISION_MID_PERIOD');
    await confirmRules(co, 11, 2026);
    const ap = await call(checker, 'post', '/api/payroll/approve').send({ month: 11, year: 2026 });
    expect(ap.status).toBe(422);
    expect(ap.body.blocked[0].issues.map(i => i.code)).toContain('REVISION_MID_PERIOD');
  });

  it('form numbering follows the tax year: Form 138 from 2026-27, Form 24Q before', async () => {
    const now = await call(co, 'get', '/api/tds/form24q?financial_year=2026-27&quarter=Q2');
    expect(now.body).toMatchObject({ form_type: '138', form_label: 'Form 138 (formerly Form 24Q)' });
    const prev = await call(co, 'get', '/api/tds/form24q?financial_year=2025-26&quarter=Q4');
    expect(prev.body).toMatchObject({ form_type: '24Q' });
  });

  // ── CTC audit (PAYROLL_DATA_FLOW_AUDIT.md Part 3) ──────────────────────────

  it('an accepted offer\'s ANNUAL CTC is shown beside a missing revision — never paid as a monthly Basic', async () => {
    const { rows: [cand] } = await pool.query(
      "INSERT INTO candidates (company_id, full_name, email) VALUES ($1, 'Offer Fixture', 'offer.fixture@test.invalid') RETURNING id", [co.companyId]);
    await pool.query(
      "INSERT INTO offer_letters (candidate_id, offered_salary, offer_status, company_id) VALUES ($1, 750000, 'accepted', $2)", [cand.id, co.companyId]);
    const id = await addEmployee('EMP006', { source_candidate_id: cand.id }, null);
    const r = await call(co, 'get', '/api/payroll/eligibility?month=12&year=2026');
    const row = r.body.data.employees.find(e => e.employee_id === id);
    expect(row.eligible).toBe(false);
    expect(row.reasons[0].message).toMatch(/Accepted offer: Annual CTC ₹7,50,000 — convert it to a MONTHLY Basic/);
    const { rows: revs } = await pool.query('SELECT 1 FROM employee_salary_assignments WHERE employee_id = $1', [id]);
    expect(revs).toHaveLength(0);
  });

  it('employer cost is one figure everywhere: run, department report, GL basis (December, with LWF)', async () => {
    await call(co, 'post', '/api/payroll/generate').send({ month: 12, year: 2026, employee_id: E.A });
    const { rows: [run] } = await pool.query(
      'SELECT gross, employer_pf, employer_esi, lwf_employer, ctc_monthly FROM payroll_runs WHERE employee_id = $1 AND month = 12 AND year = 2026', [E.A]);
    // Basic 32,000 (revision of 15-Nov) → gross 80,000; employer PF 3,000; ESI 0; KA LWF 100 → 83,100.
    expect(Number(run.ctc_monthly)).toBe(83100);
    expect(Number(run.gross) + Number(run.employer_pf) + Number(run.employer_esi) + Number(run.lwf_employer)).toBe(83100);
    const d = await call(co, 'get', '/api/payroll/dept-cost?month=12&year=2026');
    expect(d.status).toBe(200);
    // December is a DRAFT here: it is reported in the separate draft section,
    // never in the finalised totals (Part 12).
    expect(d.body.draft.grand_total).toMatchObject({ total_employer_cost: 83100, total_ctc: 83100 });
    expect(d.body.grand_total.total_employer_cost).toBe(0);
    const o = await call(other, 'get', '/api/payroll/dept-cost?month=12&year=2026');
    expect(o.body.grand_total.total_employer_cost).toBe(0);
    expect(o.body.draft.grand_total.total_employer_cost).toBe(0);
  });

  // PC-01 Q6: outside CTC mode an increment is never written straight into the
  // salary — the push used to add a revision (and touch the master Basic) with
  // no approval. It is refused; the salary changes through Salary Structures or,
  // in CTC mode, a salary proposal (integration.ctcProposals.test.js).
  it('outside CTC mode an increment push is refused and writes no salary revision', async () => {
    await pool.query("INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from, basic_salary) VALUES ($1, NULL, '2027-06-01', 50000)", [E.A]);
    const { rows: [rec] } = await pool.query(
      `INSERT INTO increment_recommendations (company_id, employee_id, current_ctc, recommended_increment_pct, recommended_new_ctc, final_new_ctc, effective_date, status)
       VALUES ($1, $2, 100, 10, 110, 110, '2027-01-01', 'approved') RETURNING id`, [co.companyId, E.A]);
    const { rows: [before] } = await pool.query('SELECT basic_salary FROM employees WHERE id = $1', [E.A]);
    const r = await call(co, 'post', `/api/performance/increments/recommendations/${rec.id}/push-payroll`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SALARY_PROPOSAL_REQUIRED');
    const { rows } = await pool.query("SELECT 1 FROM employee_salary_assignments WHERE employee_id = $1 AND effective_from = '2027-01-01'", [E.A]);
    expect(rows).toHaveLength(0);
    const { rows: [after] } = await pool.query('SELECT basic_salary FROM employees WHERE id = $1', [E.A]);
    expect(after.basic_salary).toEqual(before.basic_salary);
  });

  it('increments cannot write a salary revision onto another company\'s employee', async () => {
    const post = await call(other, 'post', '/api/performance/increments/recommendations').send({ employee_id: E.A, recommended_increment_pct: 10, current_ctc: 100 });
    expect(post.status).toBe(404);
    const { rows: [forged] } = await pool.query(
      `INSERT INTO increment_recommendations (company_id, employee_id, current_ctc, recommended_increment_pct, final_new_ctc, effective_date, status)
       VALUES ($1, $2, 100, 10, 999, '2027-02-01', 'approved') RETURNING id`, [other.companyId, E.A]);
    const push = await call(other, 'post', `/api/performance/increments/recommendations/${forged.id}/push-payroll`);
    expect(push.status).toBe(400);
    const { rows } = await pool.query("SELECT 1 FROM employee_salary_assignments WHERE employee_id = $1 AND effective_from = '2027-02-01'", [E.A]);
    expect(rows).toHaveLength(0);
  });

  it('another company sees none of it', async () => {
    const r = await call(other, 'get', `/api/payroll/payslips?employee_id=${E.A}&month=8&year=2026`);
    expect(r.status).not.toBe(200);
    const list = await call(other, 'get', '/api/payroll?month=8&year=2026');
    expect(list.body.data).toEqual([]);
    const loans = await call(other, 'get', '/api/payroll/loan-advances');
    expect(loans.body).toEqual([]);
  });
});
