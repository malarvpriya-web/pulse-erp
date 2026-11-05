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
  await pool.query(`DELETE FROM payroll_runs WHERE employee_id IN ${emps}`, [companyId]);
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
