/**
 * Leave encashment belongs to the company of its employee —
 * PAYROLL_DATA_FLOW_AUDIT.md Part 10. Two throwaway companies; every route is
 * checked for same-company access and for cross-company refusal that changes
 * nothing on either side.
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

const { default: pool }         = await import('../config/db.js');
const { verifyToken }           = await import('../middlewares/auth.middleware.js');
const { buildApp }              = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { default: encashRoutes } = await import('../modules/leaves/routes/encashment.routes.js');

const app = buildApp(['/api/leave-encashment', verifyToken, encashRoutes]);
const PREFIX = 'ZZENCOWN';
let A, B, empA, empB, leaveTypeId, claimA, claimA2, claimB;
const as = (who) => ({
  get: (p) => request(app).get(`/api/leave-encashment${p}`).set('Authorization', `Bearer ${who.token()}`),
  post: (p, b = {}) => request(app).post(`/api/leave-encashment${p}`).set('Authorization', `Bearer ${who.token()}`).send(b),
});
const claim = async (id) => (await pool.query('SELECT status, approved_by, payroll_run_id FROM leave_encashments WHERE id = $1', [id])).rows[0];

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  await pool.query(`DELETE FROM leave_encashments WHERE employee_id IN ${emps} OR company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM payroll_adjustments WHERE employee_id IN ${emps} OR company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM payroll_runs WHERE employee_id IN ${emps}`, [companyId]);
  await pool.query(`DELETE FROM leave_balances WHERE employee_id IN ${emps}`, [companyId]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [companyId]);
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  A = await createIsolatedCompany(pool, `${PREFIX}A`);
  B = await createIsolatedCompany(pool, `${PREFIX}B`);
  const emp = async (co) => (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date) VALUES ($1, 'EMP001', 'Enc', 'Test', 'Active', '2026-01-01') RETURNING id`, [co.companyId])).rows[0].id;
  empA = await emp(A); empB = await emp(B);
  leaveTypeId = (await pool.query('SELECT id FROM leave_types ORDER BY id LIMIT 1')).rows[0].id;   // FK reference only
  // A balance to encash from: approval re-checks it (2026-11-24).
  for (const e of [empA, empB]) {
    await pool.query(`INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days) VALUES ($1, $2, 2027, 30)`, [e, leaveTypeId]);
  }
  const mk = async (e, co) => (await pool.query(
    `INSERT INTO leave_encashments (employee_id, leave_type_id, year, days_encashed, net_amount, encashment_month, encashment_year, status, company_id)
     VALUES ($1, $2, 2027, 1, 1000, 4, 2027, 'pending', $3) RETURNING id`, [e, leaveTypeId, co.companyId])).rows[0].id;
  claimA = await mk(empA, A); claimA2 = await mk(empA, A); claimB = await mk(empB, B);
  await pool.query(`INSERT INTO payroll_runs (employee_id, month, year, status, gross, net_pay, is_test) VALUES ($1, 4, 2027, 'pending', 1, 1, false)`, [empB]);
}, 60000);

afterAll(async () => {
  for (const c of [A, B]) if (c) { await sweep(c.companyId); await dropIsolatedCompany(pool, c.companyId); }
}, 60000);

describe('cross-company access is refused and changes nothing', () => {
  it('list shows only the caller\'s company', async () => {
    const r = await as(A).get('/');
    expect(r.status).toBe(200);
    const ids = r.body.map(x => x.id);
    expect(ids).toEqual(expect.arrayContaining([claimA, claimA2]));
    expect(ids).not.toContain(claimB);
    expect((await as(A).get(`/?employee_id=${empB}`)).body).toEqual([]);
  });

  it('approve / reject another company\'s claim: refused; the claim and its payroll run are unchanged', async () => {
    const before = await claim(claimB);
    const runBefore = (await pool.query('SELECT leave_encashment_amount FROM payroll_runs WHERE employee_id = $1', [empB])).rows[0];
    expect((await as(A).post(`/approve/${claimB}`)).status).toBe(404);
    expect([404, 409]).toContain((await as(A).post(`/reject/${claimB}`, { reason: 'cross-company' })).status);
    expect(await claim(claimB)).toEqual(before);
    expect((await pool.query('SELECT leave_encashment_amount FROM payroll_runs WHERE employee_id = $1', [empB])).rows[0]).toEqual(runBefore);
  });

  it('create for, or eligibility of, another company\'s employee: 404 — nothing created, nothing read', async () => {
    const before = (await pool.query('SELECT COUNT(*)::int n FROM leave_encashments WHERE employee_id = $1', [empB])).rows[0].n;
    expect((await as(A).post('/', { employee_id: empB, leave_type_id: leaveTypeId, days_encashed: 1 })).status).toBe(404);
    expect((await pool.query('SELECT COUNT(*)::int n FROM leave_encashments WHERE employee_id = $1', [empB])).rows[0].n).toBe(before);
    expect((await as(A).get(`/eligible/${empB}`)).status).toBe(404);
  });

  it('a user with no company context is refused', async () => {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (name, email, password_hash, company_id, is_active, role) VALUES ('enc nocompany', $1, 'x', NULL, true, 'admin') RETURNING id`,
      [`${PREFIX.toLowerCase()}.nocompany.${Date.now()}@test.invalid`]);
    const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = 'admin' LIMIT 1`);
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [u.id, role.id]);
    const none = { token: () => jwt.sign({ userId: u.id, role: 'admin', company_id: null, employee_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
    try {
      expect((await as(none).get('/')).status).toBe(400);
      expect((await as(none).post(`/approve/${claimB}`)).status).toBe(400);
      expect((await claim(claimB)).status).toBe('pending');
    } finally {
      await pool.query('DELETE FROM user_roles WHERE user_id = $1', [u.id]);
      await pool.query('DELETE FROM users WHERE id = $1', [u.id]);
    }
  });
});

describe('same-company access still works', () => {
  it('approve and reject the caller\'s own claims; eligibility of an own employee', async () => {
    const checker = await addUser(pool, A);
    const ap = await as(checker).post(`/approve/${claimA}`); expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect((await claim(claimA)).status).toBe('approved');
    const rj = await as(A).post(`/reject/${claimA2}`, { reason: 'test' }); expect(rj.status, JSON.stringify(rj.body)).toBe(200);
    expect((await claim(claimA2)).status).toBe('cancelled');   // the table's rejected state
    const el = await as(A).get(`/eligible/${empA}`);
    expect(el.status, JSON.stringify(el.body)).toBe(200);
    expect(Array.isArray(el.body)).toBe(true);
  });
});

// 2026-11-24: approving writes a payroll earning — HR / payroll only, never
// the claimant. leaves:approve (every manager holds it) used to be enough.
describe('who may decide a claim', () => {
  it('a line manager cannot approve or cancel; nothing changes', async () => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO leave_encashments (employee_id, leave_type_id, year, days_encashed, net_amount, encashment_month, encashment_year, status, company_id)
       VALUES ($1, $2, 2027, 1, 1000, 5, 2027, 'pending', $3) RETURNING id`, [empA, leaveTypeId, A.companyId]);
    const mgr = await addUser(pool, A, { label: 'linemgr', roleCode: 'manager' });
    const ap = await as(mgr).post(`/approve/${id}`, { payout_month: 5, payout_year: 2027 });
    expect(ap.status, JSON.stringify(ap.body)).toBe(403);
    expect(ap.body.code).toBe('ENCASHMENT_DECIDER_ONLY');
    const rj = await as(mgr).post(`/reject/${id}`, { reason: 'no' });
    expect(rj.status).toBe(403);
    expect((await claim(id)).status).toBe('pending');
    expect((await pool.query('SELECT COUNT(*)::int n FROM payroll_adjustments WHERE employee_id = $1 AND month = 5 AND year = 2027', [empA])).rows[0].n).toBe(0);
  });

  it('HR cannot decide their own claim', async () => {
    const { rows: [{ id }] } = await pool.query(
      `INSERT INTO leave_encashments (employee_id, leave_type_id, year, days_encashed, net_amount, encashment_month, encashment_year, status, company_id)
       VALUES ($1, $2, 2027, 1, 1000, 6, 2027, 'pending', $3) RETURNING id`, [empA, leaveTypeId, A.companyId]);
    const hr = await addUser(pool, A, { label: 'selfhr', roleCode: 'hr' });
    await pool.query('UPDATE users SET employee_id = $1 WHERE id = $2', [empA, hr.userId]);
    const self = { token: () => jwt.sign({ userId: hr.userId, role: 'hr', company_id: A.companyId, employee_id: empA }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
    try {
      const ap = await as(self).post(`/approve/${id}`, { payout_month: 6, payout_year: 2027 });
      expect(ap.status, JSON.stringify(ap.body)).toBe(403);
      expect(ap.body.code).toBe('ENCASHMENT_SELF_DECISION');
      expect((await claim(id)).status).toBe('pending');
    } finally {
      await pool.query('UPDATE users SET employee_id = NULL WHERE id = $1', [hr.userId]);
    }
  });
});

// 2026-11-24 encashment page audit.
describe('deciding a claim — balance, exit, roles, reason', () => {
  const mkFor = async (e, days, month, reason = null) => (await pool.query(
    `INSERT INTO leave_encashments (employee_id, leave_type_id, year, days_encashed, net_amount, encashment_month, encashment_year, status, company_id, reason)
     VALUES ($1, $2, 2027, $3, 1000, $4, 2027, 'pending', $5, $6) RETURNING id`, [e, leaveTypeId, days, month, A.companyId, reason])).rows[0].id;
  const newEmp = async (code, status, allocated) => {
    const id = (await pool.query(
      `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date) VALUES ($1, $2, 'Enc', 'Rule', $3, '2026-01-01') RETURNING id`,
      [A.companyId, code, status])).rows[0].id;
    await pool.query(`INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days) VALUES ($1, $2, 2027, $3)`, [id, leaveTypeId, allocated]);
    return id;
  };

  it('payroll_admin (no leaves:approve) may decide', async () => {
    const id = await mkFor(empA, 1, 7);
    const pa = await addUser(pool, A, { label: 'payadm', roleCode: 'payroll_admin' });
    const r = await as(pa).post(`/approve/${id}`, { payout_month: 7, payout_year: 2027 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await claim(id)).status).toBe('approved');
  });

  it('approval re-checks the balance — days no longer there are refused', async () => {
    const e = await newEmp('EMP091', 'Active', 1);
    const id = await mkFor(e, 2, 8);
    const hr = await addUser(pool, A, { label: 'balhr', roleCode: 'hr' });
    const r = await as(hr).post(`/approve/${id}`, { payout_month: 8, payout_year: 2027 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('INSUFFICIENT_BALANCE');
    expect((await claim(id)).status).toBe('pending');
    expect((await pool.query('SELECT COUNT(*)::int n FROM payroll_adjustments WHERE employee_id = $1', [e])).rows[0].n).toBe(0);
  });

  it('someone serving notice is paid in F&F — no claim, no approval', async () => {
    const e = await newEmp('EMP092', 'Notice', 10);
    const id = await mkFor(e, 1, 9);
    const hr = await addUser(pool, A, { label: 'notihr', roleCode: 'hr' });
    const ap = await as(hr).post(`/approve/${id}`, { payout_month: 9, payout_year: 2027 });
    expect(ap.status).toBe(422);
    expect(ap.body.code).toBe('ENCASHMENT_AT_EXIT');
    const pay = await addUser(pool, A, { label: 'notipay', roleCode: 'payroll_admin' });
    const cr = await as(pay).post('/', { employee_id: e, leave_type_id: leaveTypeId, year: 2027, days_encashed: 1 });
    expect(cr.status).toBe(422);
    expect(cr.body.code).toBe('ENCASHMENT_AT_EXIT');
  });

  it('cancelling keeps the claim\'s own reason and adds why', async () => {
    const id = await mkFor(empA, 1, 10, 'Year-end');
    const hr = await addUser(pool, A, { label: 'rsnhr', roleCode: 'hr' });
    const r = await as(hr).post(`/reject/${id}`, { reason: 'Asked by mistake' });
    expect(r.status).toBe(200);
    const { rows: [row] } = await pool.query('SELECT status, reason FROM leave_encashments WHERE id = $1', [id]);
    expect(row.status).toBe('cancelled');
    expect(row.reason).toBe('Year-end · Cancelled: Asked by mistake');
  });
});

// Owner decisions 2026-11-24.
describe('owner decisions — who raises and who decides', () => {
  const mk = async (month) => (await pool.query(
    `INSERT INTO leave_encashments (employee_id, leave_type_id, year, days_encashed, net_amount, encashment_month, encashment_year, status, company_id)
     VALUES ($1, $2, 2027, 1, 1000, $3, 2027, 'pending', $4) RETURNING id`, [empA, leaveTypeId, month, A.companyId])).rows[0].id;

  it('hr_exec and finance_manager cannot approve or cancel', async () => {
    const id = await mk(11);
    for (const roleCode of ['hr_exec', 'finance_manager']) {
      const u = await addUser(pool, A, { label: `nd${roleCode}`, roleCode });
      const ap = await as(u).post(`/approve/${id}`, { payout_month: 11, payout_year: 2027 });
      expect(ap.status, roleCode).toBe(403);
      expect(ap.body.code, roleCode).toBe('ENCASHMENT_DECIDER_ONLY');
      expect((await as(u).post(`/reject/${id}`, { reason: 'x' })).status, roleCode).toBe(403);
    }
    expect((await claim(id)).status).toBe('pending');
  });

  it('HR cannot raise a claim for themselves', async () => {
    const hr = await addUser(pool, A, { label: 'selfraise', roleCode: 'hr' });
    await pool.query('UPDATE users SET employee_id = $1 WHERE id = $2', [empA, hr.userId]);
    const self = { token: () => jwt.sign({ userId: hr.userId, role: 'hr', company_id: A.companyId, employee_id: empA }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
    try {
      const before = (await pool.query('SELECT COUNT(*)::int n FROM leave_encashments WHERE employee_id = $1', [empA])).rows[0].n;
      const r = await as(self).post('/', { employee_id: empA, leave_type_id: leaveTypeId, year: 2027, days_encashed: 1 });
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body.code).toBe('ENCASHMENT_SELF_CLAIM');
      expect((await pool.query('SELECT COUNT(*)::int n FROM leave_encashments WHERE employee_id = $1', [empA])).rows[0].n).toBe(before);
    } finally {
      await pool.query('UPDATE users SET employee_id = NULL WHERE id = $1', [hr.userId]);
    }
  });
});
