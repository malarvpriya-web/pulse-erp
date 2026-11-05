/**
 * F-03 — payroll approval and its accrual journal are one transaction (manual §233).
 *
 * Approval used to commit first and post the accrual afterwards, best-effort:
 * a refused journal left the period approved, its payslips released and payable,
 * with no expense or Salary Payable in the GL. Now:
 *   - a refused accrual (locked period, closed period, a journal already present)
 *     rolls the approval back: the runs stay pending, nothing is released or
 *     payable, no journal, loan or arrears row changes, and the reason is returned;
 *   - a retry after the cause is fixed approves and posts exactly one journal;
 *   - concurrent approvals post one journal; the recovery route never adds one.
 *
 * The release gate answers first, so each period is made release-ready as in
 * integration.pc01MakerChecker. Drafts are inserted as fixtures; every approval
 * happens on synthetic employees in a throwaway company of the test database.
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
const { default: payrollRoutes }    = await import('../modules/payroll/payroll.routes.js');
const { default: settingsRoutes }   = await import('../modules/admin/settings-status.routes.js');
const { default: accountingRoutes } = await import('../modules/finance/accounting.routes.js');

const app = buildApp(
  ['/api/payroll', verifyToken, payrollRoutes],
  ['/api/settings', verifyToken, settingsRoutes],
  ['/api/accounting', verifyToken, accountingRoutes],
);

const PREFIX = 'ZZF03';
const Y = 2031;
const LOCKED = 1, CLOSED = 2, DUP = 3, RACE = 4;
let co, today;
const U = {}, E = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);
const approve = (who, month) => call(who, 'post', '/api/payroll/approve').send({ month, year: Y });
const tag = (m) => `${Y}-${String(m).padStart(2, '0')}`;

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  const q = (sql) => pool.query(sql, [companyId]);
  await q(`UPDATE users SET employee_id = NULL WHERE company_id = $1`);
  await q(`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE company_id = $1)`);
  await q(`DELETE FROM journal_entries WHERE company_id = $1`);
  await q(`DELETE FROM accounting_periods WHERE company_id = $1`);
  await q(`DELETE FROM tds_transactions WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM tds_deductees WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_runs WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM employee_salary_assignments WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_statutory_rules WHERE company_id = $1`);
  await q(`DELETE FROM company_settings WHERE company_id = $1`);
  await q(`DELETE FROM employees WHERE company_id = $1`);
}

async function addEmployee(code) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date,
                            pan_number, account_number, ifsc_code, uan_number)
     VALUES ($1, $2, $2, 'F03', 'Active', '2026-04-01', 'ABCDE1234F', '123456789012', 'HDFC0001234', '100200300400') RETURNING id`,
    [co.companyId, code]);
  await pool.query(`INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from, basic_salary) VALUES ($1, NULL, '2026-04-01', 30000)`, [r.id]);
  return r.id;
}

async function addDraft(employeeId, month, { gross = 30000, net = 27000, tds = 1000, pf = 2000 } = {}) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO payroll_runs (employee_id, month, year, status, gross, net_pay, total_deductions, tds,
                               employee_pf, employer_pf, employee_esi, employer_esi, professional_tax, ctc_monthly, is_test, generated_by)
     VALUES ($1, $2, $3, 'pending', $4, $5, $4::numeric - $5::numeric, $6, $7, $7, 0, 0, 0, $4::numeric + $7::numeric, false, $8) RETURNING id`,
    [employeeId, month, Y, gross, net, tds, pf, U.preparer.userId]);
  return r.id;
}

async function makeReady(month) {
  const r = await call(U.config, 'get', `/api/payroll/release-readiness?month=${month}&year=${Y}`);
  for (const b of r.body.data.blockers.filter(x => x.code.startsWith('RULE_'))) {
    const effective_from = b.code === 'RULE_MID_PERIOD' ? `${tag(month)}-01` : b.effective_from;
    const res = await call(U.config, 'post', '/api/payroll/statutory-rules')
      .send({ rule_key: b.key, effective_from, value: b.value, source_reference: `F-03 fixture ${b.key}` });
    if (res.status !== 201) throw new Error(`confirm ${b.key}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const after = await call(U.config, 'get', `/api/payroll/release-readiness?month=${month}&year=${Y}`);
  if (!after.body.data.ready) throw new Error(`not release-ready: ${JSON.stringify(after.body.data.blockers)}`);
}

const statuses = async (month) => (await pool.query(
  `SELECT pr.status FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
    WHERE e.company_id = $1 AND pr.month = $2 AND pr.year = $3 ORDER BY pr.id`, [co.companyId, month, Y])).rows.map(r => r.status);
const accruals = async (month) => (await pool.query(
  `SELECT id, reference_id, status, total_debit::numeric AS debit, total_credit::numeric AS credit, entry_date::text AS entry_date
     FROM journal_entries WHERE company_id = $1 AND reference_type = 'payroll_run' AND reference_id LIKE $2 ORDER BY id`,
  [co.companyId, `${tag(month)}:%`])).rows;
const lock = (date) => pool.query(
  `INSERT INTO company_settings (company_id, module, settings) VALUES ($1, 'finance', $2::jsonb)
   ON CONFLICT (company_id, module) DO UPDATE SET settings = EXCLUDED.settings`, [co.companyId, JSON.stringify({ lock_date: date })]);
const unlock = () => pool.query(`DELETE FROM company_settings WHERE company_id = $1 AND module = 'finance'`, [co.companyId]);
const ownPayslip = (month) => call(U.employee, 'get', `/api/payroll/payslips?employee_id=${E.SELF}&month=${month}&year=${Y}`);
const pay = (month) => call(U.payer, 'post', `/api/payroll/${E.SELF}/mark-paid`)
  .send({ month, year: Y, reference: `F03UTR${month}${Date.now() % 100000}`, value_date: today, payment_mode: 'neft' });

const RUNS = {};
beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  ({ rows: [{ d: today }] } = await pool.query(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS d`));
  await pool.query(`UPDATE companies SET state = 'Karnataka' WHERE id = $1`, [co.companyId]);
  U.preparer = await addUser(pool, co, { label: 'preparer', roleCode: 'admin' });
  U.config = await addUser(pool, co, { label: 'config', roleCode: 'payroll_admin' });
  U.fm1 = await addUser(pool, co, { label: 'fm1', roleCode: 'finance_manager' });
  U.fm2 = await addUser(pool, co, { label: 'fm2', roleCode: 'finance_manager' });
  U.payer = await addUser(pool, co, { label: 'payer', roleCode: 'finance_manager' });
  const s = await call(U.config, 'post', '/api/settings/payroll').send({ statutory_state: 'Karnataka', pay_day_of_month: 25, payroll_cutoff_day: 20 });
  if (s.status !== 200) throw new Error(`settings ${s.status}`);

  E.SELF = await addEmployee('EMP001');
  E.B = await addEmployee('EMP002');
  U.employee = await addUser(pool, co, { label: 'employee', roleCode: 'employee' });
  await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [E.SELF, U.employee.userId]);
  U.employee = { ...U.employee, token: () => jwt.sign({ userId: U.employee.userId, role: 'employee', company_id: co.companyId, employee_id: E.SELF }, process.env.JWT_SECRET, { expiresIn: '1h' }) };

  for (const m of [LOCKED, CLOSED, DUP, RACE]) {
    RUNS[m] = [await addDraft(E.SELF, m), await addDraft(E.B, m, { gross: 40000, net: 35000, tds: 3000, pf: 2000 })];
    await makeReady(m);
  }
}, 180000);

afterAll(async () => {
  if (co) { await sweep(co.companyId); await dropIsolatedCompany(pool, co.companyId); }
});

describe('F-03 an approval whose accrual is refused does not happen', () => {
  it('a locked period: 422 with the reason; runs stay pending; no journal', async () => {
    await lock('2099-12-31');
    try {
      const res = await approve(U.fm1, LOCKED);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.code).toBe('ACCRUAL_JOURNAL_REFUSED');
      expect(res.body.message).toMatch(/Nothing was approved/);
    } finally { await unlock(); }
    expect(await statuses(LOCKED)).toEqual(['pending', 'pending']);
    expect(await accruals(LOCKED)).toEqual([]);
    const { rows: [r] } = await pool.query(`SELECT approved_by, approved_at FROM payroll_runs WHERE id = $1`, [RUNS[LOCKED][0]]);
    expect(r).toEqual({ approved_by: null, approved_at: null });
  });

  it('…so the payslip is not released and the payment cannot be recorded', async () => {
    const slip = await ownPayslip(LOCKED);
    expect(slip.status).toBe(404);
    expect(slip.body.message).toMatch(/not been released/);
    const paid = await pay(LOCKED);
    expect(paid.status).toBe(409);
    expect(paid.body.message).toMatch(/must be approved/);
  });

  it('a retry after the lock is lifted approves and posts exactly one correct journal', async () => {
    const res = await approve(U.fm1, LOCKED);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.gl_posting).toMatchObject({ success: true });
    expect(await statuses(LOCKED)).toEqual(['approved', 'approved']);
    const j = await accruals(LOCKED);
    expect(j).toHaveLength(1);
    // gross 70,000 + employer PF 4,000 = 74,000 both sides; reference = lowest run id
    expect(j[0]).toMatchObject({ reference_id: `${tag(LOCKED)}:${Math.min(...RUNS[LOCKED])}`, status: 'posted', entry_date: `${tag(LOCKED)}-31` });
    expect([Number(j[0].debit), Number(j[0].credit)]).toEqual([74000, 74000]);
    const { rows: lines } = await pool.query(
      `SELECT account_code, debit::numeric AS d, credit::numeric AS c FROM journal_lines WHERE entry_id = $1 ORDER BY account_code`, [j[0].id]);
    const byCode = Object.fromEntries(lines.map(l => [l.account_code, [Number(l.d), Number(l.c)]]));
    expect(byCode['5010']).toEqual([70000, 0]);
    expect(byCode['2040']).toEqual([0, 62000]);            // net 27,000 + 35,000
    expect(byCode['2003']).toEqual([0, 4000]);             // TDS
    expect(byCode['2030']).toEqual([0, 8000]);             // PF employee + employer
  });

  it('…and only then is the payslip released and the payment recordable', async () => {
    expect((await ownPayslip(LOCKED)).status).toBe(200);
    const paid = await pay(LOCKED);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  });

  it('a closed accounting period refuses the approval too', async () => {
    const { rows: [p] } = await pool.query(
      `INSERT INTO accounting_periods (name, start_date, end_date, status, company_id)
       VALUES ('F03 closed', $1, $2, 'closed', $3) RETURNING id`, [`${tag(CLOSED)}-01`, `${tag(CLOSED)}-28`, co.companyId]);
    try {
      const res = await approve(U.fm1, CLOSED);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.code).toBe('ACCRUAL_JOURNAL_REFUSED');
      expect(await statuses(CLOSED)).toEqual(['pending', 'pending']);
      expect(await accruals(CLOSED)).toEqual([]);
    } finally {
      await pool.query(`DELETE FROM accounting_periods WHERE id = $1`, [p.id]);
    }
  });

  it('a journal already present for the batch reference refuses the approval (never a second journal)', async () => {
    const ref = `${tag(DUP)}:${Math.min(...RUNS[DUP])}`;
    const { rows: [je] } = await pool.query(
      `INSERT INTO journal_entries (entry_number, entry_date, entry_type, description, reference_type, reference_id, status, total_debit, total_credit, company_id)
       VALUES ($1, $2, 'Payroll', 'F03 pre-existing', 'payroll_run', $3, 'posted', 1, 1, $4) RETURNING id`,
      [`F03-${Date.now()}`, `${tag(DUP)}-31`, ref, co.companyId]);
    const res = await approve(U.fm1, DUP);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ACCRUAL_JOURNAL_REFUSED');
    expect(res.body.journal_code).toBe('ACCRUAL_JOURNAL_EXISTS');
    expect(await statuses(DUP)).toEqual(['pending', 'pending']);
    expect((await accruals(DUP)).map(r => r.id)).toEqual([je.id]);
    await pool.query(`DELETE FROM journal_entries WHERE id = $1`, [je.id]);
    // with the stray entry gone the approval goes through and posts its own
    expect((await approve(U.fm1, DUP)).status).toBe(200);
    expect(await accruals(DUP)).toHaveLength(1);
  });
});

describe('F-03 concurrency and recovery', () => {
  it('two concurrent approvals approve once and post one journal', async () => {
    const [a, b] = await Promise.all([approve(U.fm1, RACE), approve(U.fm2, RACE)]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect([a, b].find(r => r.status === 400).body.message).toMatch(/No pending payroll records/);
    expect(await statuses(RACE)).toEqual(['approved', 'approved']);
    expect(await accruals(RACE)).toHaveLength(1);
  });

  it('the recovery route finds nothing to add for an approved period', async () => {
    const res = await call(U.fm1, 'post', '/api/accounting/payroll-journal').send({ month: RACE, year: Y });
    expect(res.status).toBe(409);
    expect(res.body.batches.every(x => x.status === 'already_posted')).toBe(true);
    expect(await accruals(RACE)).toHaveLength(1);
  });

  it('maker-checker is unchanged: the preparer cannot approve', async () => {
    const extra = await addDraft(E.SELF, 6);
    await makeReady(6);
    const res = await approve(U.preparer, 6);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MAKER_CHECKER');
    expect(await accruals(6)).toEqual([]);
    void extra;
  });
});
