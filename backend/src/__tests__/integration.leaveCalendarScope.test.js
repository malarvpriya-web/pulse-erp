/**
 * Leave Calendar scope (2026-11-25), against a real DB in a throwaway company.
 * GET /leaves/calendar used to give every manager and department head the
 * whole company's leave, with the reason, attachment and comments (`la.*`):
 *   - admin / HR: whole company
 *   - department head: own department + direct reports
 *   - manager: self + direct reports (current reporting line)
 *   - employee: self only, whatever employee_id they send
 *   - no reason / attachment / comments in the response
 *   - /calendar/people: current staff only, same scope
 *   - bad dates / employee id → 400
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

const { default: pool }        = await import('../config/db.js');
const { verifyToken }          = await import('../middlewares/auth.middleware.js');
const { buildApp }             = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { default: leaveRoutes } = await import('../modules/leaves/routes/leaves.routes.js');

const app = buildApp(['/api/leaves', verifyToken, leaveRoutes]);
const PREFIX = 'ZZLCAL';
let A, admin, E = {}, users = {}, Z = {};

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  await pool.query(`DELETE FROM leave_applications WHERE employee_id IN ${emps}`, [companyId]);
  await pool.query(`DELETE FROM leave_types WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM holidays WHERE company_id = $1`, [companyId]);
  await pool.query(`UPDATE employees SET zone_id = NULL WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM master_zones WHERE name LIKE 'ZZLCAL %' AND id NOT IN (SELECT zone_id FROM holidays WHERE zone_id IS NOT NULL) AND id NOT IN (SELECT zone_id FROM employees WHERE zone_id IS NOT NULL)`);
  await pool.query(`UPDATE users SET employee_id = NULL WHERE company_id = $1`, [companyId]);
  await pool.query(`UPDATE employees SET reporting_manager_id = NULL WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [companyId]);
}

async function userFor(label, roleCode, employeeId) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active, role, employee_id)
     VALUES ($1, $2, 'not-a-real-hash', $3, true, $4, $5) RETURNING id`,
    [`${A.code} ${label}`, `${A.code.toLowerCase()}.${label}@test.invalid`, A.companyId, roleCode, employeeId]);
  const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = $1 LIMIT 1`, [roleCode]);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [u.id, role.id]);
  return { token: () => jwt.sign({ userId: u.id, role: roleCode, roles: [roleCode], company_id: A.companyId, employee_id: employeeId }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}

const get = (who, path) => request(app).get(`/api/leaves${path}`).set('Authorization', `Bearer ${who.token()}`);
const RANGE = '?start_date=2027-03-01&end_date=2027-03-31';
const ids = (body) => body.map(r => r.employee_id).sort((a, b) => a - b);

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  A = await createIsolatedCompany(pool, PREFIX);
  admin = await addUser(pool, A);
  const mk = async (code, dept, status = 'Active', rm = null) => (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, department, reporting_manager_id)
     VALUES ($1, $2, 'Cal', $2, $3, '2025-01-01', $4, $5) RETURNING id`, [A.companyId, code, status, dept, rm])).rows[0].id;
  E.mgr    = await mk('EMP801', 'Ops');
  E.report = await mk('EMP802', 'Sales', 'Active', E.mgr);   // reports to mgr, other dept
  E.peer   = await mk('EMP803', 'Ops');                       // same dept, not a report
  E.other  = await mk('EMP804', 'Finance');
  E.gone   = await mk('EMP805', 'Ops', 'terminated');
  const type = (await pool.query(
    `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, is_active) VALUES ('ZZ Cal', 'ZZCAL', 10, $1, true) RETURNING id`,
    [A.companyId])).rows[0].id;
  for (const e of [E.mgr, E.report, E.peer, E.other]) {
    await pool.query(
      `INSERT INTO leave_applications (employee_id, leave_type_id, start_date, end_date, number_of_days, reason, status, company_id, attachment_url, manager_comments)
       VALUES ($1, $2, '2027-03-10', '2027-03-10', 1, 'private reason', 'approved', $3, '/files/x', 'private note')`, [e, type, A.companyId]);
  }
  // Zones: mgr North, report South, other West. A holiday per zone + one company-wide.
  const zone = async (n) => (await pool.query(`INSERT INTO master_zones (name, is_active) VALUES ($1, true) RETURNING id`, [`ZZLCAL ${n}`])).rows[0].id;
  Z.north = await zone('North'); Z.south = await zone('South'); Z.west = await zone('West');
  for (const [e, z] of [[E.mgr, Z.north], [E.report, Z.south], [E.other, Z.west], [E.peer, Z.north]]) {
    await pool.query('UPDATE employees SET zone_id = $1 WHERE id = $2', [z, e]);
  }
  const hol = async (name, date, z) => pool.query(
    `INSERT INTO holidays (name, date, type, company_id, zone_id) VALUES ($1, $2, 'Festival', $3, $4)`, [name, date, A.companyId, z]);
  await hol('ZZ Company Day', '2027-01-26', null);
  await hol('ZZ North Day', '2027-02-10', Z.north);
  await hol('ZZ South Day', '2027-02-11', Z.south);
  await hol('ZZ West Day', '2027-02-12', Z.west);
  // Approved leave covering the business "today" for mgr, report and other.
  for (const e of [E.mgr, E.report, E.other]) {
    await pool.query(
      `INSERT INTO leave_applications (employee_id, leave_type_id, start_date, end_date, number_of_days, reason, status, company_id)
       VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE, 1, 'private', 'approved', $3)`, [e, type, A.companyId]);
  }
  users.mgr  = await userFor('mgr', 'manager', E.mgr);
  users.head = await userFor('head', 'department_head', E.mgr);
  users.emp  = await userFor('emp', 'employee', E.report);
}, 60000);

afterAll(async () => {
  if (A) { await sweep(A.companyId); await dropIsolatedCompany(pool, A.companyId); }
}, 60000);

describe('who the Leave Calendar shows', () => {
  it('admin sees the whole company', async () => {
    const r = await get(admin, `/calendar${RANGE}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(ids(r.body)).toEqual([E.mgr, E.report, E.peer, E.other].sort((a, b) => a - b));
  });

  it('a manager sees themself and direct reports only', async () => {
    const r = await get(users.mgr, `/calendar${RANGE}`);
    expect(r.status).toBe(200);
    expect(ids(r.body)).toEqual([E.mgr, E.report].sort((a, b) => a - b));
    // employee_id narrows inside the scope, never widens it
    expect((await get(users.mgr, `/calendar${RANGE}&employee_id=${E.other}`)).body).toEqual([]);
  });

  it('a department head sees their department plus direct reports', async () => {
    const r = await get(users.head, `/calendar${RANGE}`);
    expect(ids(r.body)).toEqual([E.mgr, E.report, E.peer].sort((a, b) => a - b));
  });

  it('an employee sees only themself', async () => {
    const r = await get(users.emp, `/calendar${RANGE}&employee_id=${E.other}`);
    expect(r.body).toEqual([]);
    expect(ids((await get(users.emp, `/calendar${RANGE}`)).body)).toEqual([E.report]);
  });

  it('sends no reason, attachment or comments', async () => {
    const r = await get(admin, `/calendar${RANGE}`);
    for (const row of r.body) {
      expect(row).not.toHaveProperty('reason');
      expect(row).not.toHaveProperty('attachment_url');
      expect(row).not.toHaveProperty('manager_comments');
    }
    expect(r.body[0]).toHaveProperty('half_day');
  });

  it('rejects bad dates and ids', async () => {
    expect((await get(admin, '/calendar?start_date=x&end_date=2027-03-31')).status).toBe(400);
    expect((await get(admin, `/calendar${RANGE}&employee_id=abc`)).status).toBe(400);
  });
});

describe('/calendar/people', () => {
  it('lists current staff only, in the same scope', async () => {
    const all = (await get(admin, '/calendar/people')).body.map(p => p.id);
    expect(all).toEqual(expect.arrayContaining([E.mgr, E.report, E.peer, E.other]));
    expect(all).not.toContain(E.gone);
    const mine = (await get(users.mgr, '/calendar/people')).body.map(p => p.id).sort((a, b) => a - b);
    expect(mine).toEqual([E.mgr, E.report].sort((a, b) => a - b));
    expect((await get(users.emp, '/calendar/people')).body.map(p => p.id)).toEqual([E.report]);
  });
});

describe('/calendar/holidays — the days off of the people shown', () => {
  const names = (body) => body.map(h => h.name).sort();
  it('a manager gets company-wide + every zone of their team, not other zones', async () => {
    const r = await get(users.mgr, '/calendar/holidays?year=2027');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(names(r.body)).toEqual(['ZZ Company Day', 'ZZ North Day', 'ZZ South Day']);
    expect(r.body.find(h => h.name === 'ZZ South Day').zone_name).toBe('ZZLCAL South');
  });
  it('one picked employee → that employee\'s zone only; outside the scope → []', async () => {
    expect(names((await get(users.mgr, `/calendar/holidays?year=2027&employee_id=${E.report}`)).body))
      .toEqual(['ZZ Company Day', 'ZZ South Day']);
    expect((await get(users.mgr, `/calendar/holidays?year=2027&employee_id=${E.other}`)).body).toEqual([]);
  });
  it('an employee gets their own zone; admin every zone', async () => {
    expect(names((await get(users.emp, '/calendar/holidays?year=2027')).body)).toEqual(['ZZ Company Day', 'ZZ South Day']);
    expect(names((await get(admin, '/calendar/holidays?year=2027')).body))
      .toEqual(expect.arrayContaining(['ZZ Company Day', 'ZZ North Day', 'ZZ South Day', 'ZZ West Day']));
  });
  it('rejects a bad year', async () => {
    expect((await get(admin, '/calendar/holidays?year=27')).status).toBe(400);
  });
});

describe('/on-leave-today — same scope as the calendar', () => {
  const who = (body) => body.employees.map(r => r.employee_id).sort((a, b) => a - b);
  it('a manager sees self + direct reports, not the company', async () => {
    const r = await get(users.mgr, '/on-leave-today');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(who(r.body)).toEqual([E.mgr, E.report].sort((a, b) => a - b));
  });
  it('an employee sees only themself; admin the company, narrowed by ?department', async () => {
    expect(who((await get(users.emp, '/on-leave-today')).body)).toEqual([E.report]);
    expect(who((await get(admin, '/on-leave-today')).body)).toEqual([E.mgr, E.report, E.other].sort((a, b) => a - b));
    expect(who((await get(admin, '/on-leave-today?department=Finance')).body)).toEqual([E.other]);
  });
  it('dates by the business day and sends no reason', async () => {
    const r = await get(admin, '/on-leave-today');
    const { rows: [{ d }] } = await pool.query('SELECT CURRENT_DATE::text AS d');
    expect(r.body.date).toBe(d);
    for (const row of r.body.employees) expect(row).not.toHaveProperty('reason');
  });
});
