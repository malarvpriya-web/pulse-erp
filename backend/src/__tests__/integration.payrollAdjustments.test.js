/**
 * One-time adjustments, arrear cancel, a held salary and the PF ECR, the
 * night-shift rate setting (manual §261). Real routers, real database, a
 * throwaway company with synthetic employees only.
 *
 *   adjustment → generate → payslip lines → a later change makes the draft stale →
 *   regenerate → approve (the deduction is credited to its account, journal
 *   balanced) → locked after approval
 *   a salary on hold no longer refuses the month's ECR
 *   an arrear can be cancelled until it is paid
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
const { auditMutations }          = await import('../middlewares/auditMutations.js');

const app = buildApp(
  ['/api/payroll', verifyToken, payrollRoutes],
  ['/api/settings', verifyToken, auditMutations('settings'), settingsRoutes],
);

const PREFIX = 'ZZPAYADJ';
const M = 9, Y = 2026;
let co, checker, credit;
const E = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);

async function confirmRules(who, month, year) {
  const r = await call(who, 'get', `/api/payroll/release-readiness?month=${month}&year=${year}`);
  for (const b of r.body.data.blockers.filter(x => x.code.startsWith('RULE_'))) {
    const effective_from = b.code === 'RULE_MID_PERIOD' ? `${year}-${String(month).padStart(2, '0')}-01` : b.effective_from;
    const res = await call(who, 'post', '/api/payroll/statutory-rules')
      .send({ rule_key: b.key, effective_from, value: b.value, source_reference: `Adjustment suite confirmation of ${b.code} ${b.key}` });
    if (res.status !== 201) throw new Error(`confirm ${b.key} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  const q = (sql) => pool.query(sql, [companyId]);
  await q(`DELETE FROM payroll_adjustments WHERE company_id = $1`);
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

async function addEmployee(code, basic) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, pan_number, account_number, ifsc_code, uan_number)
     VALUES ($1, $2, $2, 'Fixture', 'Active', '2026-04-01', 'ABCDE1234F', '123456789012', 'HDFC0001234', $3) RETURNING id`,
    [co.companyId, code, code === 'EMP001' ? '100200300400' : '100200300401']);
  await pool.query(`INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from, basic_salary) VALUES ($1, NULL, '2026-04-01', $2)`, [r.id, basic]);
  return r.id;
}

const slip = async (id) => (await call(co, 'get', `/api/payroll/payslips?employee_id=${id}&month=${M}&year=${Y}`)).body.data;

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  checker = await addUser(pool, co);
  await pool.query(`UPDATE companies SET state = 'Karnataka', tan = 'BLRZ12345A' WHERE id = $1`, [co.companyId]);
  E.A = await addEmployee('EMP001', 30000);
  E.B = await addEmployee('EMP002', 30000);
  const s = await call(co, 'post', '/api/settings/payroll').send({ statutory_state: 'Karnataka', pay_day_of_month: 25, payroll_cutoff_day: 20 });
  if (s.status !== 200) throw new Error(`settings: ${s.status} ${JSON.stringify(s.body)}`);
  const accts = (await call(co, 'get', '/api/payroll/adjustments/accounts')).body.data;
  credit = (accts.find(a => a.code === '4003') || accts.find(a => a.account_type === 'Revenue')).code;
}, 60000);

afterAll(async () => {
  if (co) { await sweep(co.companyId); await dropIsolatedCompany(pool, co.companyId); }
}, 60000);

describe('one-time adjustments', () => {
  it('validates: a deduction needs an active account, every entry a reason', async () => {
    const base = { employee_id: E.A, month: M, year: Y, label: 'Canteen', amount: 1200, reason: 'September canteen bill' };
    expect((await call(co, 'post', '/api/payroll/adjustments').send({ ...base, kind: 'deduction' })).body.code).toBe('ACCOUNT_REQUIRED');
    expect((await call(co, 'post', '/api/payroll/adjustments').send({ ...base, kind: 'deduction', account_code: 'NOPE9' })).body.code).toBe('ACCOUNT_INVALID');
    expect((await call(co, 'post', '/api/payroll/adjustments').send({ ...base, kind: 'earning', reason: '' })).status).toBe(400);
    expect((await call(co, 'post', '/api/payroll/adjustments').send({ ...base, kind: 'bonus' })).status).toBe(400);
  });

  it('is paid by the draft and itemised on the payslip', async () => {
    const add = (body) => call(co, 'post', '/api/payroll/adjustments').send({ employee_id: E.A, month: M, year: Y, ...body });
    expect((await add({ kind: 'earning', label: 'Sales incentive', amount: 5000, reason: 'Q2 target met' })).status).toBe(201);
    expect((await add({ kind: 'deduction', label: 'Canteen recovery', amount: 1200, account_code: credit, reason: 'September canteen bill' })).status).toBe(201);
    const g = await call(co, 'post', '/api/payroll/generate').send({ month: M, year: Y });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    const a = await slip(E.A), b = await slip(E.B);
    expect(a.other_earnings).toBe(5000);
    expect(a.other_deductions).toBe(1200);
    expect(a.gross).toBe(b.gross + 5000);
    expect(a.earnings).toEqual(expect.arrayContaining([{ label: 'Sales incentive', amount: 5000 }]));
    expect(a.deductions).toEqual(expect.arrayContaining([{ label: 'Canteen recovery', amount: 1200 }]));
    expect(a.net_pay).toBe(a.gross - a.total_deductions);
    const list = (await call(co, 'get', `/api/payroll/adjustments?month=${M}&year=${Y}`)).body.data;
    expect(list).toHaveLength(2);
    expect(list.every(x => x.locked === false)).toBe(true);
  });

  it('a deduction added after the draft makes it out of date until generated again', async () => {
    const r = await call(co, 'post', '/api/payroll/adjustments')
      .send({ employee_id: E.A, month: M, year: Y, kind: 'deduction', label: 'Uniform', amount: 300, account_code: credit, reason: 'Second uniform set' });
    expect(r.status).toBe(201);
    expect(r.body.message).toMatch(/Generate the payroll again/);
    const ready = (await call(co, 'get', `/api/payroll/release-readiness?month=${M}&year=${Y}`)).body.data;
    expect(ready.blockers.find(b => b.code === 'DRAFT_OUT_OF_DATE')?.employees).toContain('EMP001');
    await call(co, 'post', '/api/payroll/generate').send({ month: M, year: Y });
    expect((await slip(E.A)).other_deductions).toBe(1500);
  });

  it('a held salary is left out; approval credits the deductions to their account and balances', async () => {
    expect((await call(co, 'post', `/api/payroll/${E.B}/hold`).send({ month: M, year: Y, hold: true, reason: 'Bank details query' })).status).toBe(200);
    await confirmRules(co, M, Y);
    const r = await call(checker, 'post', '/api/payroll/approve').send({ month: M, year: Y });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { rows } = await pool.query(
      `SELECT jl.account_code, SUM(jl.debit)::float d, SUM(jl.credit)::float c FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
        WHERE je.company_id = $1 AND je.reference_type = 'payroll_run' GROUP BY jl.account_code`, [co.companyId]);
    const total = (k) => Math.round(rows.reduce((t, x) => t + x[k], 0) * 100) / 100;
    expect(total('d')).toBe(total('c'));
    expect(rows.find(x => x.account_code === credit)?.c).toBe(1500);
    const a = await slip(E.A);
    expect(rows.find(x => x.account_code === '2040')?.c).toBe(a.net_pay);
  });

  it('cannot be added, changed or removed once the month is approved', async () => {
    const r = await call(co, 'post', '/api/payroll/adjustments')
      .send({ employee_id: E.A, month: M, year: Y, kind: 'earning', label: 'Late incentive', amount: 100, reason: 'Missed last time' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PERIOD_FINALISED');
    const list = (await call(co, 'get', `/api/payroll/adjustments?month=${M}&year=${Y}`)).body.data;
    expect(list.every(x => x.locked)).toBe(true);
    expect((await call(co, 'delete', `/api/payroll/adjustments/${list[0].id}`)).status).toBe(409);
  });

  it('a salary on hold does not refuse the month\'s PF ECR; the file lists the approved members only', async () => {
    const r = await call(co, 'get', `/api/payroll/pf-ecr?month=${M}&year=${Y}`);
    expect(r.status, r.text).toBe(200);
    const lines = r.text.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('100200300400#~#')).toBe(true);
  });
});

describe('arrear cancel', () => {
  it('needs a reason; a pending arrear is cancelled once, and it is then not paid', async () => {
    const a = await call(co, 'post', '/api/payroll/arrears')
      .send({ employee_id: E.A, arrear_type: 'other', from_month: 10, from_year: Y, arrear_amount: 2500, reason: 'Shift allowance missed' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const id = a.body.id;
    expect((await call(co, 'put', `/api/payroll/arrears/${id}/cancel`).send({ reason: '' })).status).toBe(400);
    const c = await call(co, 'put', `/api/payroll/arrears/${id}/cancel`).send({ reason: 'Entered for the wrong employee' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({ status: 'cancelled', cancel_reason: 'Entered for the wrong employee' });
    expect((await call(co, 'put', `/api/payroll/arrears/${id}/cancel`).send({ reason: 'again please' })).status).toBe(409);
    expect((await call(co, 'put', `/api/payroll/arrears/${id}/approve`).send({ paid_in_month: 10, paid_in_year: Y })).status).toBe(404);
  });
});

describe('night-shift allowance setting', () => {
  it('is saved, and an impossible rate is refused', async () => {
    expect((await call(co, 'post', '/api/settings/payroll').send({ night_shift_rate: -5 })).status).toBe(400);
    const ok = await call(co, 'post', '/api/settings/payroll').send({ night_shift_rate: 350 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const { rows: [s] } = await pool.query(`SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'payroll'`, [co.companyId]);
    expect(Number(s.settings.night_shift_rate)).toBe(350);
  });
});
