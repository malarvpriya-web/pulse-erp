/**
 * Attendance → payroll sync acts on ONE company — PAYROLL_DATA_FLOW_AUDIT.md Part 10.
 *
 * SAFETY: this route freezes attendance and rewrites draft payroll runs. To make
 * sure no defect could ever touch real data, the whole suite runs on ONE
 * database connection inside a transaction that is always ROLLED BACK; every
 * statement runs in its own savepoint so an expected error cannot abort it.
 * Nothing this suite (or the route) writes is ever committed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
// backend/.env first — the test environment presets other DB values (same rule as the other real-DB suites)
const env = (k, d) => envText.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() || process.env[k] || d;
// §221: WHICH database to connect to comes from the environment first — the
// suite runs against the isolated test DB (vitest.config sets DB_NAME). Only the
// password is file-first (setup.js plants a dummy one).
const conn = (k, d) => process.env[k] || env(k, d);
if (!process.env.DATABASE_URL) process.env.DB_PASSWORD = env('DB_PASSWORD');

// ── the rolled-back connection that stands in for the app's pool ───────────
const tx = vi.hoisted(() => ({ client: null, n: 0 }));
vi.mock('../config/db.js', () => {
  const run = async (sql, params) => {
    const sp = `sp_${++tx.n}`;
    await tx.client.query(`SAVEPOINT ${sp}`);
    try { const r = await tx.client.query(sql, params); await tx.client.query(`RELEASE SAVEPOINT ${sp}`); return r; } catch (e) { await tx.client.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
  };
  const fakeClient = () => ({
    query: (sql, params) => {
      const s = String(typeof sql === 'string' ? sql : sql?.text || '').trim().toUpperCase();
      if (s === 'BEGIN') return tx.client.query('SAVEPOINT app_tx');
      if (s === 'COMMIT') return tx.client.query('RELEASE SAVEPOINT app_tx');
      if (s === 'ROLLBACK') return tx.client.query('ROLLBACK TO SAVEPOINT app_tx');
      return run(sql, params);
    },
    release: () => {},
  });
  const pool = { query: run, connect: async () => fakeClient(), on: () => {}, end: async () => {} };
  return { default: pool };
});

const { default: pool }           = await import('../config/db.js');   // the mock above
const { verifyToken }             = await import('../middlewares/auth.middleware.js');
const { buildApp }                = await import('./helpers/testApp.js');
const { createIsolatedCompany }   = await import('./helpers/isolatedCompany.js');
const { default: attendanceRoutes } = await import('../modules/attendance/routes/attendance.routes.js');

const app = buildApp(['/api/attendance', verifyToken, attendanceRoutes]);
let A, B, empA, empB;
const lop = async (emp) => (await pool.query('SELECT lop_days FROM payroll_runs WHERE employee_id = $1 AND month = 3 AND year = 2027', [emp])).rows[0].lop_days;
const sync = (who, body) => request(app).post('/api/attendance/payroll-sync').set('Authorization', `Bearer ${who.token()}`).send({ month: 3, year: 2027, force: true, ...body });

async function login(company, roleCode) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active, role) VALUES ($1, $2, 'x', $3, true, $4) RETURNING id`,
    [`sync ${roleCode}`, `sync.${roleCode}.${Date.now()}@test.invalid`, company, roleCode]);
  const { rows: [r] } = await pool.query('SELECT id FROM roles WHERE LOWER(code) = $1 LIMIT 1', [roleCode]);
  await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [u.id, r.id]);
  return { token: () => jwt.sign({ userId: u.id, role: roleCode, company_id: company, employee_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}

beforeAll(async () => {
  tx.client = new pg.Client({ host: conn('DB_HOST', 'localhost'), port: Number(conn('DB_PORT', 5432)), database: conn('DB_NAME', 'Pulse'), user: conn('DB_USER', 'postgres'), password: env('DB_PASSWORD') });
  await tx.client.connect();
  await tx.client.query('BEGIN');
  A = await createIsolatedCompany(pool, 'ZZSYNCA');
  B = await createIsolatedCompany(pool, 'ZZSYNCB');
  const emp = async (co) => (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date) VALUES ($1, 'EMP001', 'Sync', 'Test', 'Active', '2026-01-01') RETURNING id`, [co.companyId])).rows[0].id;
  empA = await emp(A); empB = await emp(B);
  await pool.query(`INSERT INTO payroll_runs (employee_id, month, year, status, gross, net_pay, lop_days, is_test) VALUES ($1, 3, 2027, 'pending', 50000, 45000, 0, false), ($2, 3, 2027, 'pending', 50000, 45000, 0, false)`, [empA, empB]);
}, 60000);

afterAll(async () => {
  if (tx.client) { await tx.client.query('ROLLBACK'); await tx.client.end(); }
});

describe('attendance payroll sync — one company only', () => {
  it('syncs the caller\'s company and never touches another company\'s runs', async () => {
    const r = await sync(A, {});
    expect(r.status).toBe(200);
    expect(r.body.lop_summary.map(x => x.employee_id)).toEqual([empA]);
    expect(Number(await lop(empA))).toBeGreaterThan(0);        // no attendance in March 2027 → LOP
    expect(Number(await lop(empB))).toBe(0);                   // company B untouched
  });

  it('naming another company\'s employee does not reach them', async () => {
    const r = await sync(A, { employee_ids: [empB] });
    expect(r.status).toBe(200);
    expect(r.body.lop_summary).toEqual([]);
    expect(Number(await lop(empB))).toBe(0);
  });

  it('a user with no company, or a global super admin, is refused before anything runs', async () => {
    const noCompany = await login(null, 'admin');
    const r1 = await sync(noCompany, {});
    expect(r1.status).toBe(400);
    const superGlobal = await login(null, 'super_admin');
    const r2 = await sync(superGlobal, {});
    expect(r2.status).toBe(400);
    expect(Number(await lop(empA))).toBeGreaterThan(0);
    expect(Number(await lop(empB))).toBe(0);
  });
});
