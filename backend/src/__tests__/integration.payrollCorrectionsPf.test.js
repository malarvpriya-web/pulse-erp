/**
 * Manual §262: employees excluded from PF, cancelling a wrongly recorded
 * statutory payment, the morning payroll reminders, and the payslip email with
 * its PDF. Real routers, real database, a throwaway company with synthetic
 * employees only; the mail transport is replaced so nothing is sent.
 *
 *   PF exclusion: refused for a UAN holder and for a wage within the ceiling;
 *   recorded for the rest → the draft carries no employee or employer PF →
 *   ending it is refused inside an approved month
 *   remittance: recorded → the month cannot be reopened → cancelled (journal
 *   reversed, the levy due again) → recorded again
 *   reminders: PF due in 3 days reaches the payers once a day, and not at all
 *   with reminders switched off
 *   payslip email: the PDF is attached; a draft is never emailed
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';

vi.mock('../utils/mailer.js', async (importOriginal) => ({ ...(await importOriginal()), sendPayslipEmail: vi.fn(async () => {}) }));

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
const { remindCompany }           = await import('../jobs/payrollReminders.cron.js');
const { sendPayslipFor }          = await import('../modules/payroll/payroll.controller.js');
const mailer                      = await import('../utils/mailer.js');

const app = buildApp(
  ['/api/payroll', verifyToken, payrollRoutes],
  ['/api/settings', verifyToken, settingsRoutes],
);

const PREFIX = 'ZZPAYPFX';
const M = 9, Y = 2026;
let co, checker;
const E = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);

async function confirmRules(who, month, year) {
  const r = await call(who, 'get', `/api/payroll/release-readiness?month=${month}&year=${year}`);
  for (const b of r.body.data.blockers.filter(x => x.code.startsWith('RULE_'))) {
    const effective_from = b.code === 'RULE_MID_PERIOD' ? `${year}-${String(month).padStart(2, '0')}-01` : b.effective_from;
    const res = await call(who, 'post', '/api/payroll/statutory-rules')
      .send({ rule_key: b.key, effective_from, value: b.value, source_reference: `PF suite confirmation of ${b.code} ${b.key}` });
    if (res.status !== 201) throw new Error(`confirm ${b.key} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  const q = (sql) => pool.query(sql, [companyId]);
  await q(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE company_id = $1)`);
  await q(`DELETE FROM payslip_email_log WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_pf_exclusions WHERE company_id = $1`);
  await q(`DELETE FROM payroll_statutory_remittances WHERE company_id = $1`);
  await q(`DELETE FROM tds_transactions WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_runs WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM employee_salary_assignments WHERE employee_id IN ${emps}`);
  await q(`UPDATE journal_entries SET reversal_of_id = NULL WHERE company_id = $1`);
  await q(`DELETE FROM journal_lines WHERE company_id = $1`);
  await q(`DELETE FROM journal_entries WHERE company_id = $1`);
  await q(`DELETE FROM payroll_statutory_rules WHERE company_id = $1`);
  await q(`DELETE FROM company_settings WHERE company_id = $1`);
  await q(`DELETE FROM employees WHERE company_id = $1`);
}

async function addEmployee(code, basic, uan) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, pan_number, account_number, ifsc_code, uan_number, company_email)
     VALUES ($1, $2, $2, 'Fixture', 'Active', '2026-04-01', 'ABCDE1234F', '123456789012', 'HDFC0001234', $3, $4) RETURNING id`,
    [co.companyId, code, uan, `${code.toLowerCase()}@example.invalid`]);
  await pool.query(`INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from, basic_salary) VALUES ($1, NULL, '2026-04-01', $2)`, [r.id, basic]);
  return r.id;
}

const slip = async (id) => (await call(co, 'get', `/api/payroll/payslips?employee_id=${id}&month=${M}&year=${Y}`)).body.data;
const pfDue = async () => (await call(co, 'get', `/api/payroll/statutory-dues?month=${M}&year=${Y}`)).body.data.items.find(i => i.kind === 'pf');

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  checker = await addUser(pool, co);
  await pool.query(`UPDATE companies SET state = 'Karnataka', tan = 'BLRZ12345A' WHERE id = $1`, [co.companyId]);
  E.member = await addEmployee('EMP001', 30000, '100200300400');   // a UAN: a PF member before
  E.high = await addEmployee('EMP002', 30000, null);               // above the ceiling, never a member
  E.low = await addEmployee('EMP003', 20000, null);                // within the ₹25,000 ceiling
  const s = await call(co, 'post', '/api/settings/payroll').send({ statutory_state: 'Karnataka', pay_day_of_month: 25, payroll_cutoff_day: 20 });
  if (s.status !== 200) throw new Error(`settings: ${s.status} ${JSON.stringify(s.body)}`);
}, 60000);

afterAll(async () => {
  if (co) { await sweep(co.companyId); await dropIsolatedCompany(pool, co.companyId); }
}, 60000);

describe('employees excluded from PF', () => {
  const exclude = (id, body = {}) => call(co, 'put', `/api/payroll/pf-exclusions/${id}`)
    .send({ effective_from: '2026-04-01', declaration_reference: 'Form 11 signed 01-Apr-2026', ...body });

  it('is refused for a UAN holder, for a wage within the ceiling, and without the Form 11 reference', async () => {
    expect((await exclude(E.member)).body.code).toBe('PF_MEMBER');
    // ₹15,000 ceiling in April: ₹20,000 is above it — September (₹25,000 ceiling) is not
    expect((await exclude(E.low, { effective_from: '2026-09-20' })).body.code).toBe('WAGE_NOT_ABOVE');
    expect((await exclude(E.high, { declaration_reference: '' })).status).toBe(400);
    expect((await exclude(E.high, { effective_from: '2026-03-01' })).status).toBe(400);
  });

  it('is recorded once, shown on the tax setup, and the draft has no PF on either side', async () => {
    const r = await exclude(E.high);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await exclude(E.high)).status).toBe(409);
    const setup = (await call(co, 'get', '/api/payroll/tax-setup?financial_year=2026-2027')).body.data.employees;
    expect(String(setup.find(x => x.employee_id === E.high).pf_excluded_from).slice(0, 10)).toBe('2026-04-01');
    expect(setup.find(x => x.employee_id === E.member).pf_excluded_from).toBeNull();
    const g = await call(co, 'post', '/api/payroll/generate').send({ month: M, year: Y });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    const high = await slip(E.high), member = await slip(E.member);
    expect(member.employee_pf).toBeGreaterThan(0);
    expect(high.employee_pf).toBe(0);
    expect(high.employer_pf).toBe(0);
    expect(Number(high.edli_employer || 0)).toBe(0);
    expect(high.gross).toBe(member.gross);
  });

  it('approves; ending the exclusion inside the approved month is refused, from the next month it is accepted', async () => {
    await confirmRules(co, M, Y);
    const a = await call(checker, 'post', '/api/payroll/approve').send({ month: M, year: Y });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const end = (ended_on) => call(co, 'put', `/api/payroll/pf-exclusions/${E.high}/end`).send({ ended_on, reason: 'Chose to join PF' });
    expect((await end('2026-09-15')).body.code).toBe('MONTH_FINALISED');
    const ok = await end('2026-10-01');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const setup = (await call(co, 'get', '/api/payroll/tax-setup?financial_year=2026-2027')).body.data.employees;
    expect(setup.find(x => x.employee_id === E.high).pf_excluded_from).toBeNull();
  });
});

describe('payroll reminders', () => {
  it('PF due in 3 days reaches the payers once a day', async () => {
    const r = await remindCompany(co.companyId, '2026-10-12');
    expect(r.notified).toBeGreaterThanOrEqual(2);
    const { rows } = await pool.query(
      `SELECT user_id, title FROM notifications WHERE notification_type = 'reminder_dues_pf' AND user_id IN ($1, $2)`, [co.adminId, checker.userId]);
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toMatch(/^PF for September 2026 due in 3 days$/);
    expect((await remindCompany(co.companyId, '2026-10-12')).notified).toBe(0);
    // 2 days before the due date is not a reminder day
    expect((await remindCompany(co.companyId, '2026-10-13')).notified).toBe(0);
  });

  it('sends nothing when switched off', async () => {
    expect((await call(co, 'post', '/api/settings/payroll').send({ payroll_reminders: false })).status).toBe(200);
    expect((await remindCompany(co.companyId, '2026-10-14')).notified).toBe(0);
    await call(co, 'post', '/api/settings/payroll').send({ payroll_reminders: true });
  });
});

describe('correcting a recorded statutory payment', () => {
  const body = { kind: 'pf', month: M, year: Y, reference: 'EPFWRONG001', paid_on: '2026-10-10' };

  it('a recorded payment blocks reopening; cancelling needs a reason', async () => {
    const r = await call(co, 'post', '/api/payroll/remittances').send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await call(checker, 'post', '/api/payroll/reopen').send({ month: M, year: Y, reason: 'should be refused now' })).body.code).toBe('REMITTED');
    expect((await call(co, 'put', `/api/payroll/remittances/${r.body.data.id}/cancel`).send({ reason: 'typo' })).status).toBe(400);
  });

  it('cancelling reverses the payment journal and makes the levy due again; the correct payment is then recorded', async () => {
    const due = await pfDue();
    expect(due.status).toBe('paid');
    const c = await call(co, 'put', `/api/payroll/remittances/${due.remittance.id}/cancel`).send({ reason: 'Wrong TRRN copied from another month' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.data.reversal_journal_id).toBeTruthy();
    expect((await call(co, 'put', `/api/payroll/remittances/${due.remittance.id}/cancel`).send({ reason: 'Wrong TRRN copied again' })).status).toBe(409);
    const { rows } = await pool.query(`
      SELECT jl.account_code, SUM(jl.debit)::float - SUM(jl.credit)::float AS net FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
       WHERE je.company_id = $1 AND je.reference_type IN ('statutory_remittance', 'statutory_remittance_reversal') GROUP BY 1`, [co.companyId]);
    expect(rows.length).toBe(2);
    expect(rows.every(x => Math.abs(x.net) < 0.005)).toBe(true);
    const after = await pfDue();
    expect(after.status).not.toBe('paid');
    expect(after.cancelled).toHaveLength(1);
    expect(after.cancelled[0]).toMatchObject({ challan_reference: 'EPFWRONG001', cancel_reason: 'Wrong TRRN copied from another month' });
    const again = await call(co, 'post', '/api/payroll/remittances').send({ ...body, reference: 'EPFRIGHT001' });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect((await pfDue()).remittance.challan_reference).toBe('EPFRIGHT001');
  });
});

describe('payslip email', () => {
  it('attaches the payslip PDF and logs the send', async () => {
    const r = await sendPayslipFor({ company_id: co.companyId, employee_id: E.member, month: M, year: Y });
    expect(r.status).toBe('sent');
    const [to, args] = mailer.sendPayslipEmail.mock.calls.at(-1);
    expect(to).toBe('emp001@example.invalid');
    expect(args.attachments[0].filename).toBe(`payslip_EMP001_${M}_${Y}.pdf`);
    expect(args.attachments[0].content.subarray(0, 5).toString()).toBe('%PDF-');
    const { rows: [log] } = await pool.query('SELECT status FROM payslip_email_log WHERE employee_id = $1 AND month = $2 AND year = $3', [E.member, M, Y]);
    expect(log.status).toBe('sent');
  });

  it('never emails a month that is not approved', async () => {
    expect((await sendPayslipFor({ company_id: co.companyId, employee_id: E.member, month: 10, year: Y })).status).toBe('not_final');
  });
});
