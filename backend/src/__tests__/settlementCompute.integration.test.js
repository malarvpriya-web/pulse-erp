/**
 * Full & Final through the real route and database (manual §253): the figures come from the
 * salary revision, leave balance and loans on record; every compute is kept; a paid exit
 * stays closed; approve and pay stay suspended.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { default: pool } = await import('../config/db.js');
const { default: exitRoutes } = await import('../modules/hr/exit.routes.js');
const { computeFnf } = await import('../modules/hr/fnf.service.js');

const TAG = 'ZZFNF';
let company, leaveType, app;
const employees = [];

const as = (role, company_id) => (req, _res, next) => {
  req.user = { userId: null, role, roles: [role], company_id };
  req.scope = { company_id };
  next();
};

async function addLeaver({ joining = '2020-04-01', lwd = '2026-10-31', notice = 30, type = 'Permanent', basic = 26000, sep = 'resignation', fnf = null } = {}) {
  const code = `EMP${100 + employees.length}`;
  const { rows: [e] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, employment_type)
     VALUES ($1, $2, 'Zz', $2, 'Notice', $3, $4) RETURNING id`, [company, code, joining, type]);
  employees.push(e.id);
  if (basic) await pool.query(`INSERT INTO employee_salary_assignments (employee_id, basic_salary, effective_from, company_id) VALUES ($1, $2, '2020-04-01', $3)`, [e.id, basic, company]);
  const { rows: [x] } = await pool.query(
    `INSERT INTO exit_requests (employee_id, separation_type, last_working_date, status, fnf_status, reason, notice_period, created_at)
     VALUES ($1, $2, $3, 'active', $4, 'zz', $5, '2026-10-01') RETURNING id`, [e.id, sep, lwd, fnf, notice]);
  return { emp: e.id, exit: x.id };
}

beforeAll(async () => {
  const { rows: [c] } = await pool.query(`INSERT INTO companies (name, code) VALUES ('ZZ FNF Co', $1) RETURNING id`, [`${TAG}${Date.now() % 100000}`]);
  company = c.id;
  const { rows: [t] } = await pool.query(
    `INSERT INTO leave_types (leave_name, leave_code, annual_quota, is_encashable, company_id) VALUES ('ZZ Earned', $1, 12, true, $2) RETURNING id`, [`ZZ${Date.now() % 10000}`, company]);
  leaveType = t.id;
  app = express();
  app.use(express.json());
  app.use('/exit', as('hr_manager', company), exitRoutes);
  void jwt;
});

afterAll(async () => {
  await pool.query(`DELETE FROM fnf_settlements WHERE company_id = $1`, [company]);
  await pool.query(`DELETE FROM exit_requests WHERE employee_id = ANY($1::int[])`, [employees]);
  await pool.query(`DELETE FROM payroll_loans WHERE employee_id = ANY($1::int[])`, [employees]);
  await pool.query(`DELETE FROM leave_balances WHERE employee_id = ANY($1::int[])`, [employees]);
  await pool.query(`DELETE FROM employee_salary_assignments WHERE employee_id = ANY($1::int[])`, [employees]);
  await pool.query(`DELETE FROM employees WHERE id = ANY($1::int[])`, [employees]);
  await pool.query(`DELETE FROM leave_types WHERE id = $1`, [leaveType]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [company]);
});

const compute = (emp, body = {}) => request(app).post(`/exit/fnf/compute/${emp}`).send(body);
const line = (r, code) => r.body.computation_details.lines.find((l) => l.code === code);

describe('POST /exit/fnf/compute', () => {
  it('reads the salary revision and the leave balance, which the old engine never did', async () => {
    const s = await addLeaver();
    await pool.query(
      `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days, carried_forward_days, opening_balance, encashed_days)
       VALUES ($1, $2, 2026, 10, 4, 3, 2, 1)`, [s.emp, leaveType]);
    const r = await compute(s.emp, { notice_start: '2026-10-02' });
    expect(r.status).toBe(200);
    expect(line(r, 'LEAVE').quantity).toBe(10);
    expect(line(r, 'LEAVE').amount).toBeGreaterThan(0);
    expect(line(r, 'GRATUITY').quantity).toBe(7);
    expect(line(r, 'FINAL_SALARY').amount).toBeGreaterThan(0);
    expect(line(r, 'NOTICE').quantity).toBe(0);
    expect(JSON.stringify(r.body)).not.toMatch(/pf_balance|tds_on_pf/);
  });

  it('every rule is reported as not confirmed', async () => {
    const s = await addLeaver();
    const r = await compute(s.emp);
    expect(r.body.computation_details.rules_unconfirmed.map((u) => u.key)).toContain('settlement.gratuity');
  });

  it('each compute adds a version, and the stored net is the latest', async () => {
    const s = await addLeaver();
    const a = await compute(s.emp, { notice_start: '2026-10-12' });
    const b = await compute(s.emp, { notice_start: '2026-10-22' });
    expect([a.body.version, b.body.version]).toEqual([1, 2]);
    expect(b.body.net_payable).toBeLessThan(a.body.net_payable);
    const { rows } = await pool.query(`SELECT version, net_payable, lines, inputs FROM fnf_settlements WHERE exit_request_id = $1 ORDER BY version`, [s.exit]);
    expect(rows).toHaveLength(2);
    expect(rows[0].inputs.options.notice_start).toBe('2026-10-12');
    expect(rows[0].lines.length).toBeGreaterThan(0);
    const { rows: [e] } = await pool.query(`SELECT net_payable FROM exit_requests WHERE id = $1`, [s.exit]);
    expect(Number(e.net_payable)).toBe(b.body.net_payable);
    const h = await request(app).get(`/exit/fnf/settlements/${s.emp}`);
    expect(h.body.data.map((v) => v.version)).toEqual([2, 1]);
  });

  it('active loans are recovered, and test loans ignored with a warning', async () => {
    const s = await addLeaver();
    await pool.query(
      `INSERT INTO payroll_loans (employee_id, loan_type, principal_amount, emi_amount, outstanding_balance, start_date, status, is_test)
       VALUES ($1, 'Loan', 9000, 1000, 5000, '2026-01-01', 'active', false), ($1, 'Seed', 9000, 1000, 7777, '2026-01-01', 'active', true)`, [s.emp]);
    const r = await compute(s.emp);
    expect(line(r, 'LOAN').amount).toBe(5000);
    expect(r.body.computation_details.lines.filter((l) => l.code === 'LOAN')).toHaveLength(1);
    expect(r.body.computation_details.warnings.map((w) => w.code)).toContain('TEST_LOANS_IGNORED');
  });

  it.each([
    [{ lop_days: 40 }, /between 0 and 31/],
    [{ waive_notice_days: 3 }, /needs a reason/],
    [{ waive_notice_days: -1 }, /negative/],
    [{ notice_start: 'soon' }, /must be a date/],
    [{ notice_start: '2027-01-01' }, /after the last working day/],
  ])('refuses %j and stores nothing', async (body, msg) => {
    const s = await addLeaver();
    const r = await compute(s.emp, body);
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(msg);
    expect((await pool.query(`SELECT 1 FROM fnf_settlements WHERE exit_request_id = $1`, [s.exit])).rows).toEqual([]);
  });

  it('with no last working day it asks for one', async () => {
    const s = await addLeaver({ lwd: null });
    const r = await compute(s.emp);
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/last working day/);
  });

  it('a paid settlement cannot be recomputed', async () => {
    const s = await addLeaver({ fnf: 'paid' });
    expect((await compute(s.emp)).status).toBe(409);
    expect((await pool.query(`SELECT 1 FROM fnf_settlements WHERE exit_request_id = $1`, [s.exit])).rows).toEqual([]);
  });

  it('another company sees nothing, and its history is empty', async () => {
    const s = await addLeaver();
    await compute(s.emp);
    expect(await computeFnf(pool, s.emp, { companyId: company + 987654 })).toBeNull();
    const other = express();
    other.use(express.json());
    other.use('/exit', as('hr_manager', company + 987654), exitRoutes);
    expect((await request(other).post(`/exit/fnf/compute/${s.emp}`).send({})).status).toBe(404);
    expect((await request(other).get(`/exit/fnf/settlements/${s.emp}`)).body.data).toEqual([]);
  });

  it('approve and pay stay suspended, because the rules are not confirmed', async () => {
    const s = await addLeaver();
    const r = await compute(s.emp);
    expect(r.body).toMatchObject({ provisional: true, settlement_actions_suspended: true });
    expect((await request(app).put(`/exit/fnf/${s.exit}/approve`).send({})).status).toBe(423);
    expect((await request(app).post(`/exit/fnf/${s.exit}/pay`).send({})).status).toBe(423);
  });
});

// 2026-11-12 (owner): the yearly sales incentive is never paid automatically on exit.
// HR decides (pay an amount / do not pay, with a reason); the decision stays on later
// recalculations until changed; Finance is told only when it changes.
describe('POST /exit/fnf/compute · sales incentive decision', () => {
  it('pay adds a line, a recalculation keeps it, and only a change is reported for Finance', async () => {
    const s = await addLeaver();
    const a = await compute(s.emp, { sales_incentive_decision: 'pay', sales_incentive_amount: 25000, sales_incentive_reason: 'Agreed with the sales head' });
    expect(a.status).toBe(200);
    expect(line(a, 'SALES_INCENTIVE')).toMatchObject({ amount: 25000, direction: 'payable' });
    expect(a.body.sales_incentive_decision_changed).toMatchObject({ decision: 'pay', amount: 25000 });

    const b = await compute(s.emp);                                   // no decision sent
    expect(line(b, 'SALES_INCENTIVE').amount).toBe(25000);           // kept
    expect(b.body.sales_incentive_decision_changed).toBeNull();      // nothing new for Finance
    expect(b.body.net_payable).toBe(a.body.net_payable);

    const c = await compute(s.emp, { sales_incentive_decision: 'not_pay', sales_incentive_reason: 'Left before the year ended' });
    expect(line(c, 'SALES_INCENTIVE')).toMatchObject({ amount: 0 });
    expect(line(c, 'SALES_INCENTIVE').basis).toMatch(/not to pay: Left before/);
    expect(c.body.sales_incentive_decision_changed).toMatchObject({ decision: 'not_pay' });
    expect(c.body.net_payable).toBeLessThan(b.body.net_payable);

    const d = await compute(s.emp, { sales_incentive_decision: 'undecided' });
    expect(line(d, 'SALES_INCENTIVE')).toBeUndefined();
  });

  it('a decision needs a reason, and pay needs an amount', async () => {
    const s = await addLeaver();
    expect((await compute(s.emp, { sales_incentive_decision: 'pay', sales_incentive_amount: 1000 })).status).toBe(422);
    expect((await compute(s.emp, { sales_incentive_decision: 'pay', sales_incentive_reason: 'agreed amount' })).status).toBe(422);
    expect((await compute(s.emp, { sales_incentive_decision: 'maybe', sales_incentive_reason: 'agreed amount' })).status).toBe(422);
  });

  it('with no target and no decision there is no incentive line', async () => {
    const s = await addLeaver();
    const r = await compute(s.emp);
    expect(line(r, 'SALES_INCENTIVE')).toBeUndefined();
    expect(r.body.computation_details.sales_incentive).toBeNull();
  });
});
