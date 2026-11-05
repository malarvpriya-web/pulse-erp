/**
 * PC-02a payroll payment controls (manual §232; migration 20261104000003).
 *
 *   PD-1  a payment is recorded only with a UTR + value date, in ONE transaction
 *         with its salary-clearing journal and TDS row; refused postings leave
 *         the run approved; replays are idempotent; a UTR is used once
 *   PD-2  payroll_admin no longer approves payroll
 *   PD-3  admin / super_admin may record payment, never as preparer or approver,
 *         audited as administrator authority
 *   PD-15 the manual payroll journal is recovery only — amounts derived, one per
 *         approval batch, lock dates respected
 *   PD-16 full bank account numbers only for employee_bank:view
 *
 * Real routers and database; two throwaway companies, synthetic employees and
 * synthetic APPROVED runs (inserted as fixtures — nothing is generated or
 * approved through the API here). Every payment recorded is on those fixtures,
 * in the isolated test database, and removed with the companies.
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

const { default: pool }              = await import('../config/db.js');
const { verifyToken }                = await import('../middlewares/auth.middleware.js');
const { buildApp }                   = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { default: payrollRoutes }     = await import('../modules/payroll/payroll.routes.js');
const { default: accountingRoutes }  = await import('../modules/finance/accounting.routes.js');
const { postPayrollJournal }         = await import('../modules/finance/services/payrollJournal.service.js');

const app = buildApp(
  ['/api/payroll', verifyToken, payrollRoutes],
  ['/api/accounting', verifyToken, accountingRoutes],
);

const PREFIX = 'ZZPC02A';
const Y = 2030;
const PAY_M = 1, REC_M = 2, LOCK_M = 3;   // payment tests · journal recovery · locked recovery
let co, other, today;
const U = {}, B = {}, E = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);
const pay = (who, employeeId, body = {}) => call(who, 'post', `/api/payroll/${employeeId}/mark-paid`)
  .send({ month: PAY_M, year: Y, value_date: today, payment_mode: 'neft', ...body });

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  const q = (sql) => pool.query(sql, [companyId]);
  await q(`UPDATE users SET employee_id = NULL WHERE company_id = $1`);
  await q(`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE company_id = $1)`);
  await q(`DELETE FROM journal_entries WHERE company_id = $1`);
  await q(`DELETE FROM tds_transactions WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM tds_deductees WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_runs WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM company_settings WHERE company_id = $1`);
  await q(`DELETE FROM employees WHERE company_id = $1`);
}

let empSeq = 100;
async function addEmployee(company) {
  empSeq += 1;
  const code = `EMP${empSeq}`;
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date,
                            pan_number, account_number, ifsc_code, uan_number)
     VALUES ($1, $2, $2, 'Pc02a', 'Active', '2025-04-01', 'ABCDE1234F', $3, 'HDFC0001234', '100200300400') RETURNING id`,
    [company.companyId, code, `98765432${String(empSeq).padStart(4, '0')}`]);
  return r.id;
}

/** A fixture APPROVED run — prepared by `preparer`, approved by `approver`, at `approvedAt`. */
async function approvedRun(employeeId, month, { preparer, approver, approvedAt = 'NOW()', gross = 30000, net = 27000, tds = 1000, pf = 2000 }) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO payroll_runs (employee_id, month, year, status, gross, net_pay, total_deductions, tds,
                               employee_pf, employer_pf, employee_esi, employer_esi, professional_tax, ctc_monthly, is_test,
                               generated_by, approved_by, approved_at)
     VALUES ($1, $2, $3, 'approved', $4, $5, $4::numeric - $5::numeric, $6, $7, $7, 0, 0, 0, $4::numeric + $7::numeric, false, $8, $9, ${approvedAt})
     RETURNING id`, [employeeId, month, Y, gross, net, tds, pf, preparer.userId, approver.userId]);
  return r.id;
}

const runOf = async (employeeId, month = PAY_M) => (await pool.query(
  `SELECT status, payment_reference, payment_mode, value_date::text AS value_date, paid_by, paid_at, reconciled_at
     FROM payroll_runs WHERE employee_id = $1 AND month = $2 AND year = $3`, [employeeId, month, Y])).rows[0];
const clearings = async (employeeId, month = PAY_M) => (await pool.query(
  `SELECT je.id, je.status, je.entry_date::text AS entry_date, je.total_debit,
          json_agg(json_build_object('code', jl.account_code, 'debit', jl.debit, 'credit', jl.credit) ORDER BY jl.id) AS lines
     FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
    WHERE je.company_id = $1 AND je.reference_type = 'salary_disbursement' AND je.reference_id = $2
    GROUP BY je.id`, [co.companyId, `${employeeId}-${Y}-${String(month).padStart(2, '0')}`])).rows;
const tdsRows = async (employeeId) => (await pool.query(
  `SELECT COUNT(*)::int AS n FROM tds_transactions WHERE employee_id = $1 AND payroll_year = $2 AND section = '192'`, [employeeId, Y])).rows[0].n;
const lock = (date) => pool.query(
  `INSERT INTO company_settings (company_id, module, settings) VALUES ($1, 'finance', $2::jsonb)
   ON CONFLICT (company_id, module) DO UPDATE SET settings = EXCLUDED.settings`, [co.companyId, JSON.stringify({ lock_date: date })]);
const unlock = () => pool.query(`DELETE FROM company_settings WHERE company_id = $1 AND module = 'finance'`, [co.companyId]);

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  ({ rows: [{ d: today }] } = await pool.query(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS d`));
  U.preparer = await addUser(pool, co, { label: 'preparer', roleCode: 'payroll_admin' });
  U.approver = await addUser(pool, co, { label: 'approver', roleCode: 'finance_manager' });
  U.payer = await addUser(pool, co, { label: 'payer', roleCode: 'finance_manager' });
  U.admin = await addUser(pool, co, { label: 'adminpayer', roleCode: 'admin' });
  U.superAdmin = await addUser(pool, co, { label: 'superpayer', roleCode: 'super_admin' });
  U.hr = await addUser(pool, co, { label: 'hr', roleCode: 'hr' });
  U.finance = await addUser(pool, co, { label: 'finance', roleCode: 'finance' });
  B.finance_manager = await addUser(pool, other, { label: 'fm', roleCode: 'finance_manager' });

  for (const k of ['A', 'B', 'C', 'D', 'ADM', 'SUP', 'LOCKED', 'APPRADMIN']) E[k] = await addEmployee(co);
  E.SELF = await addEmployee(co);
  U.employee = await addUser(pool, co, { label: 'employee', roleCode: 'employee' });
  await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [E.SELF, U.employee.userId]);
  U.employee = { ...U.employee, token: () => jwt.sign({ userId: U.employee.userId, role: 'employee', company_id: co.companyId, employee_id: E.SELF }, process.env.JWT_SECRET, { expiresIn: '1h' }) };

  const std = { preparer: U.preparer, approver: U.approver };
  for (const k of ['A', 'B', 'C', 'D', 'ADM', 'SUP', 'LOCKED', 'SELF']) await approvedRun(E[k], PAY_M, std);
  await approvedRun(E.APPRADMIN, PAY_M, { preparer: U.preparer, approver: U.admin });
  // Recovery fixtures: two approval batches in REC_M (two approved_at values), one in LOCK_M.
  await approvedRun(E.A, REC_M, { ...std, approvedAt: `TIMESTAMPTZ '${Y}-02-27 10:00:00+05:30'`, gross: 30000, net: 27000, tds: 1000, pf: 2000 });
  await approvedRun(E.B, REC_M, { ...std, approvedAt: `TIMESTAMPTZ '${Y}-02-27 10:00:00+05:30'`, gross: 40000, net: 35000, tds: 3000, pf: 2000 });
  await approvedRun(E.C, REC_M, { ...std, approvedAt: `TIMESTAMPTZ '${Y}-02-28 11:00:00+05:30'`, gross: 20000, net: 18000, tds: 0, pf: 2000 });
  await approvedRun(E.A, LOCK_M, { ...std, approvedAt: `TIMESTAMPTZ '${Y}-03-30 10:00:00+05:30'` });
}, 90000);

afterAll(async () => {
  for (const c of [co, other]) {
    if (!c) continue;
    await sweep(c.companyId);
    await dropIsolatedCompany(pool, c.companyId);
  }
});

// ── PD-1 / PD-3 — recording a payment ───────────────────────────────────────
describe('PD-1 a payment needs bank evidence', () => {
  it('without a UTR, with a malformed one, or without a value date nothing is recorded', async () => {
    for (const [body, code] of [[{}, 'UTR_REQUIRED'], [{ reference: '  ' }, 'UTR_REQUIRED'], [{ reference: 'ab' }, 'UTR_REQUIRED'],
      [{ reference: 'UTR 123 456' }, 'UTR_REQUIRED'], [{ reference: 'HDFCN52030010100', value_date: '' }, 'VALUE_DATE_REQUIRED']]) {
      const res = await pay(U.payer, E.A, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code, JSON.stringify(body)).toBe(code);
    }
    expect((await runOf(E.A)).status).toBe('approved');
    expect(await clearings(E.A)).toEqual([]);
  });

  it('a future value date, or one before approval, is refused', async () => {
    expect((await pay(U.payer, E.A, { reference: 'HDFCN52030010101', value_date: '2099-01-01' })).body.code).toBe('VALUE_DATE_FUTURE');
    expect((await pay(U.payer, E.A, { reference: 'HDFCN52030010101', value_date: '2020-01-01' })).body.code).toBe('VALUE_DATE_BEFORE_APPROVAL');
    expect((await runOf(E.A)).status).toBe('approved');
  });

  it('records the payment, its clearing journal and its TDS row together', async () => {
    const res = await pay(U.payer, E.A, { reference: ' hdfcn52030010101 ' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ reference: 'HDFCN52030010101', reconciled: false, amount: 27000 });
    const run = await runOf(E.A);
    expect(run).toMatchObject({ status: 'paid', payment_reference: 'HDFCN52030010101', payment_mode: 'neft', value_date: today, paid_by: U.payer.userId });
    expect(run.paid_at).toBeTruthy();
    expect(run.reconciled_at).toBeNull();                 // a UTR is not reconciliation
    const je = await clearings(E.A);
    expect(je).toHaveLength(1);
    expect(je[0]).toMatchObject({ status: 'posted', entry_date: today });
    expect(je[0].lines.map(l => [l.code, Number(l.debit), Number(l.credit)])).toEqual([['2040', 27000, 0], ['1001', 0, 27000]]);
    expect(await tdsRows(E.A)).toBe(1);
  });

  it('the same confirmation again is idempotent — no second journal', async () => {
    const res = await pay(U.payer, E.A, { reference: 'HDFCN52030010101' });
    expect(res.status).toBe(200);
    expect(res.body.data.already_paid).toBe(true);
    expect(await clearings(E.A)).toHaveLength(1);
    expect(await tdsRows(E.A)).toBe(1);
  });

  it('a paid run cannot be confirmed again with a different reference', async () => {
    const res = await pay(U.payer, E.A, { reference: 'HDFCN52030019999' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_PAID');
    expect((await runOf(E.A)).payment_reference).toBe('HDFCN52030010101');
  });

  it('a UTR already used for another payment is refused (any case)', async () => {
    const res = await pay(U.payer, E.B, { reference: 'HdfcN52030010101' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('UTR_ALREADY_USED');
    expect((await runOf(E.B)).status).toBe('approved');
    expect(await clearings(E.B)).toEqual([]);
  });

  it('two concurrent confirmations of one run post one journal', async () => {
    const [a, b] = await Promise.all([pay(U.payer, E.B, { reference: 'ICICN52030020202' }), pay(U.payer, E.B, { reference: 'ICICN52030020202' })]);
    expect([a.status, b.status].sort()).toEqual([200, 200]);
    expect([a.body.data.already_paid, b.body.data.already_paid].filter(Boolean)).toHaveLength(1);
    expect(await clearings(E.B)).toHaveLength(1);
  });

  it('if the clearing journal is refused (locked period) the payment is NOT recorded', async () => {
    await lock('2099-12-31');
    try {
      const res = await pay(U.payer, E.LOCKED, { reference: 'SBINN52030030303' });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.code).toBe('CLEARING_JOURNAL_REFUSED');
    } finally { await unlock(); }
    const run = await runOf(E.LOCKED);
    expect(run).toMatchObject({ status: 'approved', payment_reference: null, paid_by: null });
    expect(await clearings(E.LOCKED)).toEqual([]);
    expect(await tdsRows(E.LOCKED)).toBe(0);
    // the same UTR is free to use once the period is open
    expect((await pay(U.payer, E.LOCKED, { reference: 'SBINN52030030303' })).status).toBe(200);
  });
});

describe('PD-1 / PD-3 segregation and authority', () => {
  it('the preparer and the approver cannot record the payment', async () => {
    expect((await pay(U.approver, E.C, { reference: 'UTIBN52030040404' })).body.code).toBe('PAYER_IS_APPROVER');
    const asPreparer = await pay(U.preparer, E.C, { reference: 'UTIBN52030040404' });
    expect(asPreparer.status).toBe(403);                  // payroll_admin holds no payroll_payment grant
    expect((await runOf(E.C)).status).toBe('approved');
  });

  it('an administrator who approved the run cannot pay it either', async () => {
    const res = await pay(U.admin, E.APPRADMIN, { reference: 'UTIBN52030050505' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAYER_IS_APPROVER');
  });

  it('admin and super_admin may record a payment — with evidence, audited as administrator authority', async () => {
    expect((await pay(U.admin, E.ADM, {})).body.code).toBe('UTR_REQUIRED');
    expect((await pay(U.admin, E.ADM, { reference: 'KKBKN52030060606' })).status).toBe(200);
    expect((await pay(U.superAdmin, E.SUP, { reference: 'KKBKN52030070707' })).status).toBe(200);
    await new Promise(r => { setTimeout(r, 300); });     // logAudit is fire-and-forget
    const { rows } = await pool.query(
      `SELECT user_id, action_type FROM audit_logs WHERE user_id = ANY($1) AND action_type IN ('payment_recorded', 'payment_admin_authority') ORDER BY id`,
      [[U.admin.userId, U.superAdmin.userId]]);
    const by = (u) => rows.filter(r => Number(r.user_id) === u.userId).map(r => r.action_type).sort();
    expect(by(U.admin)).toEqual(['payment_admin_authority', 'payment_recorded']);
    expect(by(U.superAdmin)).toEqual(['payment_admin_authority', 'payment_recorded']);
  });

  it('roles without the payment grant, and other companies, cannot record payment', async () => {
    expect((await pay(U.hr, E.D, { reference: 'PUNBN52030080808' })).status).toBe(403);
    expect((await pay(U.finance, E.D, { reference: 'PUNBN52030080808' })).status).toBe(403);
    expect((await pay(B.finance_manager, E.D, { reference: 'PUNBN52030080808' })).status).toBe(404);
    expect((await runOf(E.D)).status).toBe('approved');
  });
});

// ── PD-2 — payroll approval ─────────────────────────────────────────────────
describe('PD-2 payroll approval is Finance and the administrators', () => {
  it('the matrix: payroll approve = admin, finance_manager, super_admin; payment = the same three', async () => {
    const holders = async (module) => (await pool.query(
      `SELECT LOWER(r.code) AS c FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.module = $1 AND rp.can_approve ORDER BY 1`, [module])).rows.map(r => r.c);
    expect(await holders('payroll')).toEqual(['admin', 'finance_manager', 'super_admin']);
    expect(await holders('payroll_payment')).toEqual(['admin', 'finance_manager', 'super_admin']);
  });

  it('payroll_admin is refused at the approval gate', async () => {
    const res = await call(U.preparer, 'post', '/api/payroll/approve').send({ month: 4, year: Y });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });
});

// ── PD-15 — manual payroll journal is recovery only ─────────────────────────
describe('PD-15 payroll journal recovery', () => {
  const recover = (who, body) => call(who, 'post', '/api/accounting/payroll-journal').send(body);
  const accruals = async (month) => (await pool.query(
    `SELECT reference_id, total_debit, total_credit, status FROM journal_entries
      WHERE company_id = $1 AND reference_type = 'payroll_run' AND reference_id LIKE $2 ORDER BY reference_id`,
    [co.companyId, `${Y}-${String(month).padStart(2, '0')}:%`])).rows;

  it('refuses any user-entered amount or reference', async () => {
    for (const body of [{ month: REC_M, year: Y, gross_salary: 1 }, { payroll_run_id: 'x', payroll_month: `${Y}-02`, net_salary: 5 }]) {
      const res = await recover(U.approver, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AMOUNTS_NOT_ACCEPTED');
    }
    expect(await accruals(REC_M)).toEqual([]);
  });

  it('posts one journal per approval batch, with amounts derived from the runs', async () => {
    const res = await recover(U.approver, { month: REC_M, year: Y });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.posted).toBe(2);
    const rows = await accruals(REC_M);
    expect(rows).toHaveLength(2);
    // batch 1 (A + B): gross 70,000 + employer PF 4,000; batch 2 (C): 20,000 + 2,000
    expect(rows.map(r => [Number(r.total_debit), Number(r.total_credit), r.status]).sort((a, b) => a[0] - b[0]))
      .toEqual([[22000, 22000, 'posted'], [74000, 74000, 'posted']]);
  });

  it('never creates a second journal for an already-posted batch', async () => {
    const res = await recover(U.approver, { month: REC_M, year: Y });
    expect(res.status).toBe(409);
    expect(res.body.batches.every(b => b.status === 'already_posted')).toBe(true);
    expect(await accruals(REC_M)).toHaveLength(2);
  });

  it('concurrent direct posts of one reference produce one journal (lock + unique index)', async () => {
    const args = { payroll_run_id: `${Y}-06:999999`, payroll_month: `${Y}-06`, gross_salary: 1000, net_salary: 1000, pf_employer: 0, esi_employer: 0, companyId: co.companyId };
    const [a, b] = await Promise.all([postPayrollJournal(args), postPayrollJournal(args)]);
    expect([a.success, b.success].filter(Boolean)).toHaveLength(1);
    expect([a.reason, b.reason].filter(r => r === 'already_posted')).toHaveLength(1);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM journal_entries WHERE company_id = $1 AND reference_id = $2`, [co.companyId, `${Y}-06:999999`]);
    expect(rows[0].n).toBe(1);
  });

  it('respects the accounting lock date', async () => {
    await lock('2099-12-31');
    try {
      const res = await recover(U.approver, { month: LOCK_M, year: Y });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.batches[0].status).toBe('refused');
    } finally { await unlock(); }
    expect(await accruals(LOCK_M)).toEqual([]);
  });

  it('is scoped to the caller\'s company and needs finance:approve', async () => {
    const res = await recover(B.finance_manager, { month: REC_M, year: Y });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NO_APPROVED_PAYROLL');
    expect((await recover(U.hr, { month: REC_M, year: Y })).status).toBe(403);
    expect((await recover(U.approver, { month: 13, year: Y })).status).toBe(400);
  });
});

// ── PD-16 — bank account masking ────────────────────────────────────────────
describe('PD-16 bank account numbers', () => {
  const accountOf = async (id) => (await pool.query(`SELECT account_number FROM employees WHERE id = $1`, [id])).rows[0].account_number;

  it('the payroll list masks the account for payroll viewers without employee_bank:view', async () => {
    const fm = await call(U.approver, 'get', `/api/payroll?month=${PAY_M}&year=${Y}`);
    expect(fm.status).toBe(200);
    const row = fm.body.data.find(r => r.employee_id === E.C);
    const full = await accountOf(E.C);
    expect(row.bank_account).toBe(`XXXX${full.slice(-4)}`);
    const hr = await call(U.hr, 'get', `/api/payroll?month=${PAY_M}&year=${Y}`);
    expect(hr.body.data.find(r => r.employee_id === E.C).bank_account).toBe(full);
  });

  it('payslip responses carry no full account number for them either', async () => {
    const res = await call(U.approver, 'get', `/api/payroll/payslips?employee_id=${E.C}&month=${PAY_M}&year=${Y}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(await accountOf(E.C));
    const own = await call(U.employee, 'get', `/api/payroll/payslips?employee_id=${E.SELF}&month=${PAY_M}&year=${Y}`);
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toContain(await accountOf(E.SELF));
  });

  it('the register export follows the same rule', async () => {
    const full = await accountOf(E.C);
    const fm = await call(U.approver, 'get', `/api/payroll/register?month=${PAY_M}&year=${Y}`);
    expect(fm.status).toBe(200);
    expect(fm.text).not.toContain(full);
    expect(fm.text).toContain(`XXXX${full.slice(-4)}`);
    const hr = await call(U.hr, 'get', `/api/payroll/register?month=${PAY_M}&year=${Y}`);
    expect(hr.text).toContain(full);
  });
});
