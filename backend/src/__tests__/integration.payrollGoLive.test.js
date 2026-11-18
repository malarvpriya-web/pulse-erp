/**
 * Payroll go-live controls (2026-11-09), through the real routers and database:
 * attendance before approval, the generate preview, reopen with a reversed
 * journal, hold, discard, statutory dues and remittances, opening balances and
 * the employee's tax regime, the bank file, and future months.
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
const { default: tdsRoutes }      = await import('../modules/finance/tds.routes.js');

const app = buildApp(['/api/payroll', verifyToken, payrollRoutes], ['/api/settings', verifyToken, settingsRoutes], ['/api/tds', verifyToken, tdsRoutes]);
const PREFIX = 'ZZGOLV';
const Y = 2026;
let co, checker, payer, hr;
const E = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);
const ready = async (m) => (await call(co, 'get', `/api/payroll/release-readiness?month=${m}&year=${Y}`)).body.data;

async function confirmRules(m) {
  const r = await ready(m);
  for (const b of r.blockers.filter(x => x.code.startsWith('RULE_'))) {
    const effective_from = b.code === 'RULE_MID_PERIOD' ? `${Y}-${String(m).padStart(2, '0')}-01` : b.effective_from;
    const res = await call(co, 'post', '/api/payroll/statutory-rules').send({ rule_key: b.key, effective_from, value: b.value, source_reference: `go-live suite ${b.key}` });
    if (res.status !== 201) throw new Error(`confirm ${b.key}: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  const q = (sql) => pool.query(sql, [companyId]);
  await q(`DELETE FROM payroll_statutory_remittances WHERE company_id = $1`);
  await q(`DELETE FROM payroll_statutory_rule_changes WHERE company_id = $1`);
  await q(`DELETE FROM payroll_loan_repayments WHERE loan_id IN (SELECT id FROM payroll_loans WHERE employee_id IN ${emps})`);
  await q(`DELETE FROM payroll_loans WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_opening_balances WHERE company_id = $1`);
  await q(`DELETE FROM employee_tax_regime WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_attendance_summary WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM tds_transactions WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM tds_deductees WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_runs WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM employee_salary_assignments WHERE employee_id IN ${emps}`);
  await q(`UPDATE journal_entries SET reversal_of_id = NULL WHERE company_id = $1`);
  await q(`DELETE FROM journal_lines WHERE company_id = $1`);
  await q(`DELETE FROM journal_entries WHERE company_id = $1`);
  await q(`DELETE FROM payroll_statutory_rules WHERE company_id = $1`);
  await q(`DELETE FROM company_settings WHERE company_id = $1`);
  await q(`DELETE FROM employees WHERE company_id = $1`);
}

async function addEmployee(code, basic = 30000) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, pan_number, account_number, ifsc_code, uan_number, bank_name)
     VALUES ($1, $2, $2, 'GoLive', 'Active', '2026-04-01', 'ABCDE1234F', '001234567890', 'HDFC0001234', '100200300400', 'HDFC Bank') RETURNING id`,
    [co.companyId, code]);
  await pool.query(`INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from, basic_salary) VALUES ($1, NULL, '2026-04-01', $2)`, [r.id, basic]);
  return r.id;
}
const runOf = async (id, m) => (await pool.query('SELECT * FROM payroll_runs WHERE employee_id = $1 AND month = $2 AND year = $3', [id, m, Y])).rows[0];

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  checker = await addUser(pool, co);
  payer = await addUser(pool, co, { label: 'payer', roleCode: 'finance_manager' });
  hr = await addUser(pool, co, { label: 'hr', roleCode: 'hr_manager' });
  await pool.query(`UPDATE companies SET state = 'Karnataka' WHERE id = $1`, [co.companyId]);
  const s = await call(co, 'post', '/api/settings/payroll').send({ statutory_state: 'Karnataka', pay_day_of_month: 25, payroll_cutoff_day: 20, require_attendance_sync: true });
  if (s.status !== 200) throw new Error(`settings ${s.status}`);
  E.A = await addEmployee('EMP001');
  E.B = await addEmployee('EMP002', 120000);
}, 60000);

afterAll(async () => {
  if (co) { await sweep(co.companyId); await dropIsolatedCompany(pool, co.companyId); }
}, 60000);

describe('attendance before approval', () => {
  it('the preview gives the totals Generate will save', async () => {
    const pv = (await call(co, 'get', `/api/payroll/preview-run?month=8&year=${Y}`)).body.data;
    expect((await call(co, 'post', '/api/payroll/generate').send({ month: 8, year: Y })).status).toBe(200);
    const saved = [await runOf(E.A, 8), await runOf(E.B, 8)];
    expect(pv.count).toBe(2);
    expect(pv.gross).toBe(saved.reduce((s, r) => s + Number(r.gross), 0));
    expect(pv.net_pay).toBe(saved.reduce((s, r) => s + Number(r.net_pay), 0));
  });

  it('a draft with no attendance sync cannot be approved — loss of pay would be 0', async () => {
    await confirmRules(8);
    const r = await ready(8);
    expect(r.blockers.map(b => b.code)).toEqual(['ATTENDANCE_NOT_SYNCED']);
  });

  it('a sync before the cutoff day is not enough', async () => {
    for (const id of [E.A, E.B]) {
      await pool.query(`INSERT INTO payroll_attendance_summary (company_id, employee_id, month, year, working_days, lop_days, synced_at)
                        VALUES ($1, $2, 8, $3, 21, 0, '2026-08-10')`, [co.companyId, id, Y]);
    }
    expect((await ready(8)).blockers.map(b => b.code)).toEqual(['ATTENDANCE_SYNC_EARLY']);
  });

  it('a later sync with absence makes the draft out of date; regenerating pays less', async () => {
    await pool.query(`UPDATE payroll_attendance_summary SET lop_days = 3, synced_at = '2026-08-31' WHERE employee_id = $1 AND month = 8`, [E.A]);
    await pool.query(`UPDATE payroll_attendance_summary SET synced_at = '2026-08-31' WHERE employee_id = $1 AND month = 8`, [E.B]);
    expect((await ready(8)).blockers.map(b => b.code)).toEqual(['DRAFT_OUT_OF_DATE']);
    const before = Number((await runOf(E.A, 8)).gross);
    await call(co, 'post', '/api/payroll/generate').send({ month: 8, year: Y });
    const after = await runOf(E.A, 8);
    expect(Number(after.lop_days)).toBe(3);
    // 3 of the 21 counted days lost (each pay component is rounded on its own, so within ₹2)
    expect(Math.abs(Number(after.gross) - before * 18 / 21)).toBeLessThanOrEqual(2);
    expect((await ready(8)).ready).toBe(true);
  });
});

describe('approve, reopen, approve again', () => {
  it('approves and posts one accrual', async () => {
    expect((await call(checker, 'post', '/api/payroll/approve').send({ month: 8, year: Y })).status).toBe(200);
  });

  it('reopening needs a reason; then the accrual is reversed and the runs are drafts again', async () => {
    expect((await call(checker, 'post', '/api/payroll/reopen').send({ month: 8, year: Y, reason: 'oops' })).status).toBe(400);
    const r = await call(checker, 'post', '/api/payroll/reopen').send({ month: 8, year: Y, reason: 'EMP001 attendance corrected by HR' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ reopened: 2, journals_reversed: 1 });
    expect((await runOf(E.A, 8)).status).toBe('pending');
    const { rows: [net] } = await pool.query(`
      SELECT SUM(jl.debit - jl.credit)::numeric AS n, COUNT(DISTINCT je.id)::int AS entries
        FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
       WHERE je.company_id = $1 AND je.reference_type IN ('payroll_run', 'payroll_run_reversal') AND jl.account_code = '5010'`, [co.companyId]);
    expect(Number(net.n)).toBe(0);
    expect(net.entries).toBe(2);
  });

  it('approving again posts a fresh accrual beside the reversed one', async () => {
    expect((await call(checker, 'post', '/api/payroll/approve').send({ month: 8, year: Y })).status).toBe(200);
    const { rows } = await pool.query(`SELECT reference_id FROM journal_entries WHERE company_id = $1 AND reference_type = 'payroll_run' ORDER BY created_at`, [co.companyId]);
    expect(rows.map(r => r.reference_id)[1]).toMatch(/^2026-08:\d+:r1$/);
  });
});

describe('statutory dues and payments', () => {
  it('lists what August owes, with due dates', async () => {
    const d = (await call(co, 'get', `/api/payroll/statutory-dues?month=8&year=${Y}`)).body.data;
    const pf = d.items.find(i => i.kind === 'pf');
    const runs = [await runOf(E.A, 8), await runOf(E.B, 8)];
    const sum = (k) => runs.reduce((s, r) => s + Number(r[k]), 0);
    const admin = Math.max(sum('pf_admin_employer'), 500);
    expect(pf.amount).toBe(sum('employee_pf') + sum('employer_pf') + sum('edli_employer') + admin);
    expect(pf.due_date).toBe('2026-09-15');
    expect(d.items.find(i => i.kind === 'tds').due_date).toBe('2026-09-07');
  });

  it('HR cannot record a payment; Finance can, once; then the month cannot be reopened', async () => {
    const body = { kind: 'pf', month: 8, year: Y, reference: 'EPFTRRN0001', paid_on: '2026-09-10' };
    expect((await call(hr, 'post', '/api/payroll/remittances').send(body)).status).toBe(403);
    const ok = await call(payer, 'post', '/api/payroll/remittances').send(body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.journal_entry_id).toBeTruthy();
    expect((await call(payer, 'post', '/api/payroll/remittances').send(body)).status).toBe(409);
    const re = await call(checker, 'post', '/api/payroll/reopen').send({ month: 8, year: Y, reason: 'should be refused now' });
    expect(re.status).toBe(409);
    expect(re.body.code).toBe('REMITTED');
  });

  it('the bank file is Finance-only, and keeps account numbers as text', async () => {
    expect((await call(hr, 'get', `/api/payroll/bank-file?month=8&year=${Y}`)).status).toBe(403);
    const f = await call(payer, 'get', `/api/payroll/bank-file?month=8&year=${Y}`).buffer(true).parse((res, cb) => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(f.status).toBe(200);
    const XLSX = (await import('xlsx')).default;
    const ws = XLSX.read(f.body, { type: 'buffer' }).Sheets['Salary transfers'];
    expect(ws.C2).toMatchObject({ t: 's', v: '001234567890' });     // the leading zeros survive
  });
});

describe('hold and discard', () => {
  it('a held salary is left out of approval and can be released', async () => {
    await pool.query(`INSERT INTO payroll_attendance_summary (company_id, employee_id, month, year, working_days, lop_days, synced_at)
                      SELECT $1, id, 9, $2, 22, 0, '2026-09-30' FROM employees WHERE company_id = $1`, [co.companyId, Y]);
    await call(co, 'post', '/api/payroll/generate').send({ month: 9, year: Y });
    expect((await call(co, 'post', `/api/payroll/${E.B}/hold`).send({ month: 9, year: Y, reason: 'x' })).status).toBe(400);
    expect((await call(co, 'post', `/api/payroll/${E.B}/hold`).send({ month: 9, year: Y, reason: 'Bank details being verified' })).status).toBe(200);
    await confirmRules(9);
    const ap = await call(checker, 'post', '/api/payroll/approve').send({ month: 9, year: Y });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body.approved_count).toBe(1);
    expect((await runOf(E.B, 9)).status).toBe('on_hold');
    expect((await call(co, 'post', `/api/payroll/${E.B}/hold`).send({ month: 9, year: Y, hold: false })).status).toBe(200);
    expect((await runOf(E.B, 9)).status).toBe('pending');
  });

  it('discard removes drafts and never an approved run', async () => {
    const r = await call(co, 'post', '/api/payroll/discard').send({ month: 9, year: Y });
    expect(r.body.data).toEqual({ discarded: 1 });
    expect((await runOf(E.A, 9)).status).toBe('approved');
    expect(await runOf(E.B, 9)).toBeUndefined();
  });
});

describe('tax setup', () => {
  it('an opening balance and the old regime both change the tax projection', async () => {
    await pool.query(`INSERT INTO payroll_attendance_summary (company_id, employee_id, month, year, working_days, lop_days, synced_at)
                      VALUES ($1, $2, 10, $3, 22, 0, '2026-10-31')`, [co.companyId, E.B, Y]);
    await call(co, 'post', '/api/payroll/generate').send({ month: 10, year: Y, employee_id: E.B });
    const plain = await runOf(E.B, 10);
    const ob = await call(co, 'put', `/api/payroll/opening-balances/${E.B}`)
      .send({ financial_year: '2026-2027', gross: 900000, tds: 50000, employee_pf: 9000, months: 3, source: 'Form 12B from previous employer' });
    expect(ob.status, JSON.stringify(ob.body)).toBe(200);
    expect(ob.body.data).toMatchObject({ months: 3, source: 'Form 12B from previous employer' });
    expect((await ready(10)).blockers.map(b => b.code)).toContain('DRAFT_OUT_OF_DATE');
    await call(co, 'post', '/api/payroll/generate').send({ month: 10, year: Y, employee_id: E.B });
    const withOpening = await runOf(E.B, 10);
    expect(Number(withOpening.annual_taxable_income)).toBeGreaterThan(Number(plain.annual_taxable_income));
    // Only the Finance Manager records a regime (tax_regime:edit, 2026-11-11) — not an admin, not HR.
    for (const who of [co, hr]) {
      expect((await call(who, 'put', `/api/payroll/tax-regime/${E.B}`).send({ financial_year: '2026-2027', regime: 'old' })).status).toBe(403);
    }
    expect((await call(payer, 'put', `/api/payroll/tax-regime/${E.B}`).send({ financial_year: '2026-2027', regime: 'old' })).status).toBe(200);
    await call(co, 'post', '/api/payroll/generate').send({ month: 10, year: Y, employee_id: E.B });
    expect((await runOf(E.B, 10)).tax_regime).toBe('old');
    expect((await runOf(E.A, 8)).tax_regime).toBe('new');
    const setup = (await call(co, 'get', '/api/payroll/tax-setup?financial_year=2026-2027')).body.data.employees;
    expect(setup.find(e => e.employee_id === E.B)).toMatchObject({ regime: 'old', regime_declared: true });
  });

  it('opening balances need a source and sane figures', async () => {
    expect((await call(co, 'put', `/api/payroll/opening-balances/${E.A}`).send({ financial_year: '2026-2027', gross: 1000, tds: 5000, source: 'x' })).status).toBe(400);
    expect((await call(co, 'put', `/api/payroll/opening-balances/${E.A}`).send({ financial_year: '2026-2027', gross: 1000, tds: 0 })).status).toBe(400);
  });
});

describe('future months', () => {
  it('a month that has not started cannot be generated', async () => {
    const saved = process.env.PULSE_PAYROLL_TODAY;
    process.env.PULSE_PAYROLL_TODAY = '2026-11-09';
    try {
      const r = await call(co, 'post', '/api/payroll/generate').send({ month: 12, year: Y });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('FUTURE_PERIOD');
    } finally { process.env.PULSE_PAYROLL_TODAY = saved; }
  });
});

describe('loan perquisite before approval', () => {
  it('a large interest-free loan blocks the month until the rule and its SBI rate are recorded; then it is taxed', async () => {
    const l = await call(co, 'post', '/api/payroll/loan-advances')
      .send({ employee_id: E.A, loan_type: 'loan', principal_amount: 500000, tenure_months: 50, start_date: '2026-10-01' });
    expect(l.status, JSON.stringify(l.body)).toBe(201);
    await pool.query(`INSERT INTO payroll_attendance_summary (company_id, employee_id, month, year, working_days, lop_days, synced_at)
                      VALUES ($1, $2, 10, $3, 22, 0, '2026-10-31') ON CONFLICT (employee_id, month, year) DO NOTHING`, [co.companyId, E.A, Y]);
    await call(co, 'post', '/api/payroll/generate').send({ month: 10, year: Y, employee_id: E.A });
    const b = (await ready(10)).blockers.find(x => x.key === 'perq.loan');
    expect(b).toMatchObject({ code: 'RULE_UNVERIFIED', employees: ['EMP001'] });
    expect(b.message).toMatch(/missing: loan/);
    expect(b.record_from).toBe('2026-10-01');     // from this month: earlier approved months keep what they had
    const rec = await call(co, 'post', '/api/payroll/statutory-rules').send({ rule_key: 'perq.loan', effective_from: b.record_from,
      value: { exempt_limit: 200000, sbi_rates: { loan: 9.5, advance: 9.5 } }, source_reference: 'SBI rates 1 Apr 2026 (go-live suite)' });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    expect((await ready(10)).blockers.some(x => x.key === 'perq.loan')).toBe(false);
    await call(co, 'post', '/api/payroll/generate').send({ month: 10, year: Y, employee_id: E.A });
    // the month's highest balance (₹5,00,000) × 9.5% ÷ 12
    expect(Number((await runOf(E.A, 10)).perquisite_value)).toBe(Math.round(500000 * 0.095 / 12));
  });
});

describe('Form 138: the year\'s salary details', () => {
  it('lists each employee\'s salary, deductions, tax and TDS for the year', async () => {
    const r = await call(co, 'get', '/api/tds/form24q?financial_year=2026-2027');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const a = r.body.salary_details.find(s => s.employee_id === E.A);
    const { rows: [sum] } = await pool.query(`SELECT SUM(gross)::numeric AS g, SUM(tds)::numeric AS t FROM payroll_runs WHERE employee_id = $1 AND status IN ('approved','paid')`, [E.A]);
    expect(a).toMatchObject({ regime: 'new', gross_salary: Math.round(Number(sum.g)), tds_deducted: Math.round(Number(sum.t)), standard_deduction: 75000 });
    expect(a.taxable_income).toBe(Math.max(0, a.gross_salary + a.perquisites - 75000));
    expect(a.difference).toBe(a.tds_deducted - a.tax_payable);
  });
});

describe('a statutory rule change needs a second person', () => {
  const change = (value) => call(co, 'post', '/api/payroll/statutory-rules').send({ rule_key: 'pf.edli_rate', effective_from: '2027-01-01', value, source_reference: 'EPFO circular (go-live suite)' });
  const edliOn = async (d) => (await call(co, 'get', `/api/payroll/statutory-rules?date=${d}`)).body.data.resolved['pf.edli_rate'];
  it('with the setting on, a change is only a proposal until someone else confirms it', async () => {
    expect((await call(co, 'post', '/api/settings/payroll').send({ statutory_state: 'Karnataka', pay_day_of_month: 25, payroll_cutoff_day: 20, rules_two_person: true })).status).toBe(200);
    const p = await change(0.6);
    expect(p.status, JSON.stringify(p.body)).toBe(202);
    expect(await edliOn('2027-01-31')).toBe(0.5);
    const mine = await call(co, 'post', `/api/payroll/statutory-rules/changes/${p.body.data.id}/confirm`).send({});
    expect(mine.status).toBe(403);
    expect(mine.body.code).toBe('SAME_PERSON');
    const ok = await call(checker, 'post', `/api/payroll/statutory-rules/changes/${p.body.data.id}/confirm`).send({ note: 'checked the circular' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await edliOn('2027-01-31')).toBe(0.6);
  });

  it('a pending change blocks approval of the months it covers; a rejected one changes nothing', async () => {
    const p = await change(0.7);
    expect(p.status).toBe(202);
    expect((await call(co, 'get', `/api/payroll/release-readiness?month=1&year=2027`)).body.data.blockers.map(b => b.code)).toContain('RULE_CHANGE_PENDING');
    expect((await call(checker, 'post', `/api/payroll/statutory-rules/changes/${p.body.data.id}/reject`).send({ note: 'wrong rate' })).status).toBe(200);
    expect(await edliOn('2027-01-31')).toBe(0.6);
    const list = (await call(co, 'get', '/api/payroll/statutory-rules/changes')).body.data;
    expect(list.map(c => c.status).sort()).toEqual(['confirmed', 'rejected']);
  });

  it('recording the value already in force is a confirmation, not a change, and applies at once', async () => {
    expect((await change(0.6)).status).toBe(201);
  });

  // Owner decision, 10 Nov 2026: a super admin may decide their own proposal; it is audited as such.
  it('a super admin may confirm their own proposal, and the record says no second person', async () => {
    const sa = await addUser(pool, co, { label: 'superadmin', roleCode: 'super_admin' });
    const p = await call(sa, 'post', '/api/payroll/statutory-rules').send({ rule_key: 'pf.edli_rate', effective_from: '2027-01-01', value: 0.65, source_reference: '' });
    expect(p.status, JSON.stringify(p.body)).toBe(202);
    const ok = await call(sa, 'post', `/api/payroll/statutory-rules/changes/${p.body.data.id}/confirm`).send({ note: 'checked' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.change.decision_note).toMatch(/^Decided by the super admin who proposed it \(no second person\)\. checked$/);
    expect(await edliOn('2027-01-31')).toBe(0.65);
    // the audit write is fire-and-forget: wait for it
    let a;
    for (let i = 0; i < 20 && a?.action_type !== 'self_confirm'; i++) {
      ({ rows: [a] } = await pool.query(`SELECT action_type FROM audit_logs WHERE reference_type = 'payroll_statutory_rule_change' AND reference_id = $1 ORDER BY id DESC LIMIT 1`, [String(p.body.data.id)]));
      if (a?.action_type !== 'self_confirm') await new Promise(r => setTimeout(r, 50));
    }
    expect(a?.action_type).toBe('self_confirm');
  });
});

describe('Form No. 123 (formerly Form 12BA): statement of perquisites', () => {
  it('values the loan perquisite from approved payroll, marks every other line as not provided, and states the tax', async () => {
    // Finance's loan account mapping (normally set in Accounting → Loan account mapping)
    const { setLoanGlMapping } = await import('../modules/finance/services/loanGlMapping.service.js');
    await setLoanGlMapping(co.companyId, { receivable_account_code: '1013', interest_income_account_code: '4006' }, payer.userId);
    // the October drafts predate the perquisite rule recorded above (DRAFT_PREDATES_RULE)
    await call(co, 'post', '/api/payroll/generate').send({ month: 10, year: Y });
    const ap = await call(checker, 'post', '/api/payroll/approve').send({ month: 10, year: Y });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    const r = await call(co, 'get', `/api/payroll/form123/${E.A}?financial_year=2026-2027`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const f = r.body.data;
    const { rows: [sum] } = await pool.query(`SELECT SUM(gross)::numeric g, SUM(perquisite_value)::numeric p, SUM(tds)::numeric t FROM payroll_runs WHERE employee_id = $1 AND status IN ('approved','paid')`, [E.A]);
    expect(f).toMatchObject({ form: 'Form No. 123', required: true, salary_excluding_perquisites: Math.round(Number(sum.g)) });
    const loan = f.items.find(i => i.label === 'Interest-free or concessional loans');
    expect(loan.value).toBe(Math.round(Number(sum.p)));
    expect(loan.value).toBeGreaterThan(0);
    expect(f.items.filter(i => i.source === 'not_in_pulse').every(i => i.value === null)).toBe(true);
    expect(f.tax.deducted_from_salary).toBe(Math.round(Number(sum.t)));
    expect(f.form_label).toBe('Form No. 123 (formerly Form 12BA)');
  });

  it('is issued with the annual certificate: refused, with the reasons, until that is ready', async () => {
    const r = await call(co, 'get', `/api/payroll/form123/${E.A}/pdf?financial_year=2026-2027`);
    expect(r.status).toBe(409);
    expect(r.body.blockers.join(' ')).toMatch(/not finalised/);
  });

  it('before tax year 2026-27 it is Form 12BA', async () => {
    const r = await call(co, 'get', `/api/payroll/form123/${E.A}?financial_year=2025-2026`);
    expect(r.body.data).toMatchObject({ form: 'Form 12BA', required: false });
  });
});
