/**
 * Zone holiday calendars (owner, 2026-11-24): a holiday with no zone is the
 * whole company's; one with a zone only that zone's employees'. An employee
 * reads their own calendar from GET /holidays; HR reads all, one zone, or one
 * employee's. There are no optional / restricted holidays.
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

const { default: pool }          = await import('../config/db.js');
const { verifyToken }            = await import('../middlewares/auth.middleware.js');
const { buildApp }               = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies } = await import('./helpers/isolatedCompany.js');
const { default: holidayRoutes } = await import('../modules/holidays/routes/holidays.routes.js');

const app = buildApp(['/api/holidays', verifyToken, holidayRoutes]);
const PREFIX = 'ZZHOLZONE';
let A, zone, empIn, empOut, userIn;

async function sweep(companyId) {
  await pool.query('UPDATE users SET employee_id = NULL WHERE company_id = $1', [companyId]);
  await pool.query('DELETE FROM holidays WHERE company_id = $1', [companyId]);
  await pool.query('DELETE FROM employees WHERE company_id = $1', [companyId]);
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  A = await createIsolatedCompany(pool, PREFIX);
  zone = (await pool.query('SELECT id FROM master_zones ORDER BY id LIMIT 1')).rows[0]?.id ?? null;
  const mk = async (code, z) => (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, zone_id)
     VALUES ($1, $2, 'Hol', $2, 'Active', '2025-01-01', $3) RETURNING id`, [A.companyId, code, z])).rows[0].id;
  empIn = await mk('EMP951', zone);
  empOut = await mk('EMP952', null);
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active, role, employee_id)
     VALUES ($1, $2, 'not-a-real-hash', $3, true, 'employee', $4) RETURNING id`,
    [`${A.code} in`, `${A.code.toLowerCase()}.in@test.invalid`, A.companyId, empIn]);
  userIn = u.id;
  const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = 'employee' LIMIT 1`);
  await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userIn, role.id]);
  await pool.query(
    `INSERT INTO holidays (name, date, type, company_id, zone_id) VALUES
       ('ZZ Company Day', '2031-03-03', 'Company', $1, NULL),
       ('ZZ Zone Day', '2031-03-04', 'Regional', $1, $2)`, [A.companyId, zone]);
}, 60000);

afterAll(async () => { if (A) { await sweep(A.companyId); await dropIsolatedCompany(pool, A.companyId); } }, 60000);

const names = (r) => r.body.map(h => h.name).filter(n => n.startsWith('ZZ ')).sort();
const tokenFor = (empId) => jwt.sign({ userId: userIn, role: 'employee', company_id: A.companyId, employee_id: empId }, process.env.JWT_SECRET, { expiresIn: '1h' });

describe('zone calendars', () => {
  it('an employee in the zone and HR see both days; HR asking for an employee outside the zone sees the company day only', async () => {
    if (zone == null) return;   // no master zone in this database
    expect(names(await request(app).get('/api/holidays?year=2031').set('Authorization', `Bearer ${tokenFor(empIn)}`))).toEqual(['ZZ Company Day', 'ZZ Zone Day']);
    expect(names(await request(app).get('/api/holidays?year=2031').set('Authorization', `Bearer ${A.token()}`))).toEqual(['ZZ Company Day', 'ZZ Zone Day']);
    expect(names(await request(app).get(`/api/holidays?year=2031&employee_id=${empOut}`).set('Authorization', `Bearer ${A.token()}`))).toEqual(['ZZ Company Day']);
  });

  it('an employee outside the zone does not see the zone day', async () => {
    if (zone == null) return;
    await pool.query('UPDATE users SET employee_id = $1 WHERE id = $2', [empOut, userIn]);
    try {
      expect(names(await request(app).get('/api/holidays?year=2031').set('Authorization', `Bearer ${tokenFor(empOut)}`))).toEqual(['ZZ Company Day']);
    } finally {
      await pool.query('UPDATE users SET employee_id = $1 WHERE id = $2', [empIn, userIn]);
    }
  });

  it('there is no optional holiday type', async () => {
    const r = await request(app).post('/api/holidays').set('Authorization', `Bearer ${A.token()}`)
      .send({ name: 'ZZ Opt', date: '2031-03-05', type: 'Optional' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('HOLIDAY_TYPE');
  });
});
