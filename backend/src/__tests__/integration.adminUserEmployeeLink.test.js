/**
 * User Management links a login to its employee (users.employee_id).
 *
 * users.employee_id is the only way a login finds its employee record
 * (auth.service resolveEmployeeId — the email is deliberately not used), so a
 * login created on Settings → Access Control → User Management without it had
 * empty payslips, leave and attendance. Create and Edit now take employee_id.
 *
 * Proven here: create links; edit links, relinks and unlinks; a person who
 * already has an active login cannot get a second one (create, edit, or
 * reactivating an old linked login); another tenant's or a deleted employee is
 * a 404; an edit without employee_id leaves the link alone; the user list and
 * the picker report the link.
 *
 * Real database and real admin router; auth is the caller stub (server.js puts
 * verifyToken at the /admin mount). Fixtures live in test companies
 * 999996/999997 and are deleted by captured id.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }        = await import('../config/db.js');
const { default: adminRoutes } = await import('../modules/admin/admin.routes.js');

vi.setConfig({ testTimeout: 20000 });

const COMPANY = 999996;
const OTHER   = 999997;
const stamp = Date.now();
const PREFIX = `zz.link.${stamp}.`;
let seq = 0;
const nextEmail = () => `${PREFIX}${++seq}@example.com`;

const app = express();
app.use(express.json());
app.use('/api/admin', (req, res, next) => {
  const raw = req.headers['x-test-user'];
  if (!raw) return res.status(401).json({ error: 'Unauthorized' });
  const u = JSON.parse(raw);
  req.user  = { id: null, userId: null, roles: u.roles, role: u.roles[0], company_id: COMPANY };
  req.scope = { company_id: COMPANY };
  next();
}, adminRoutes);
const ADMIN = { 'x-test-user': JSON.stringify({ roles: ['super_admin'] }) };

const employeeIds = [];
let emp1, emp2, empOther, empDeleted;

async function addEmployee(company, code, { deleted = false } = {}) {
  const { rows: [e] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, status, department, joining_date, deleted_at)
     VALUES ($1, $2, 'ZZLink', 'Fixture', $3, 'Active', 'Production', CURRENT_DATE, $4) RETURNING id`,
    [company, code, `${PREFIX}emp.${code.toLowerCase()}@example.com`, deleted ? new Date() : null]);
  employeeIds.push(e.id);
  return e.id;
}

const create = (body) => request(app).post('/api/admin/users').set(ADMIN)
  .send({ name: 'ZZLink User', email: nextEmail(), password: 'ZzLink-Pass-123', role: 'production_manager', ...body });
const edit = (id, body) => request(app).put(`/api/admin/users/${id}`).set(ADMIN).send(body);
const userRow = async (id) => (await pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];

beforeAll(async () => {
  for (const [id, code] of [[COMPANY, 'ZZLINKA'], [OTHER, 'ZZLINKB']])
    await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [id, `ZZLink Fixture ${code}`, code]);
  emp1       = await addEmployee(COMPANY, `EMP9${stamp % 1000000}1`);
  emp2       = await addEmployee(COMPANY, `EMP9${stamp % 1000000}2`);
  empDeleted = await addEmployee(COMPANY, `EMP9${stamp % 1000000}3`, { deleted: true });
  empOther   = await addEmployee(OTHER,   `EMP9${stamp % 1000000}4`);
});

afterAll(async () => {
  const { rows } = await pool.query(`SELECT id FROM users WHERE LOWER(email) LIKE $1`, [`${PREFIX}%`]);
  const ids = rows.map(r => r.id);
  if (ids.length) {
    await pool.query('DELETE FROM user_roles WHERE user_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM user_scope WHERE user_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
  }
  await pool.query('DELETE FROM employees WHERE id = ANY($1::int[])', [employeeIds]);
  // The fixture companies are this suite's alone (testTenantIds contract);
  // best-effort, since a row some trigger hung off them would block it.
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[]) AND name LIKE 'ZZLink Fixture%'`, [[COMPANY, OTHER]])
    .catch(e => console.warn('[adminUserEmployeeLink] fixture companies left behind:', e.message));
});

describe('create', () => {
  it('links the new login to the chosen employee', async () => {
    const res = await create({ employee_id: emp1 });
    expect(res.status).toBe(201);
    expect(res.body.user.employee_id).toBe(emp1);
    expect(await userRow(res.body.user.id)).toMatchObject({ employee_id: emp1, company_id: COMPANY, role: 'production_manager' });
  });

  it('refuses a second active login for the same person, naming the existing one', async () => {
    const res = await create({ employee_id: emp1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already has a login \(zz\.link\./);
  });

  it('without employee_id still creates an unlinked login', async () => {
    const res = await create({});
    expect(res.status).toBe(201);
    expect((await userRow(res.body.user.id)).employee_id).toBeNull();
  });

  it("another tenant's employee and a deleted employee are both 404, and nothing is created", async () => {
    for (const employee_id of [empOther, empDeleted]) {
      const email = nextEmail();
      const res = await create({ employee_id, email });
      expect(res.status).toBe(404);
      const { rows } = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
      expect(rows).toHaveLength(0);
    }
  });

  it('a non-numeric employee_id is a 400', async () => {
    expect((await create({ employee_id: 'abc' })).status).toBe(400);
  });
});

describe('edit', () => {
  let userId;
  beforeAll(async () => { userId = (await create({})).body.user.id; });

  it('links an existing unlinked login', async () => {
    expect((await edit(userId, { employee_id: emp2 })).status).toBe(200);
    expect((await userRow(userId)).employee_id).toBe(emp2);
  });

  it('saving the same link again is allowed (the login itself is not "another" login)', async () => {
    expect((await edit(userId, { employee_id: emp2, role: 'sales_manager' })).status).toBe(200);
    expect(await userRow(userId)).toMatchObject({ employee_id: emp2, role: 'sales_manager' });
  });

  it('an edit without employee_id leaves the link alone', async () => {
    expect((await edit(userId, { department: 'Sales' })).status).toBe(200);
    expect((await userRow(userId)).employee_id).toBe(emp2);
  });

  it('cannot take a person who already has another active login', async () => {
    const res = await edit(userId, { employee_id: emp1 });
    expect(res.status).toBe(409);
    expect((await userRow(userId)).employee_id).toBe(emp2);
  });

  it('unlinks with null', async () => {
    expect((await edit(userId, { employee_id: null })).status).toBe(200);
    expect((await userRow(userId)).employee_id).toBeNull();
  });

  it('reactivating an old linked login is refused once that person has another active login', async () => {
    const old = (await create({ employee_id: emp2 })).body.user.id;
    expect((await edit(old, { status: 'inactive' })).status).toBe(200);
    const fresh = (await create({ employee_id: emp2 })).body.user.id;
    expect(fresh).toBeTruthy();
    const res = await edit(old, { status: 'active' });
    expect(res.status).toBe(409);
    expect((await userRow(old)).is_active).toBe(false);
  });
});

describe('reads', () => {
  it('the user list carries the linked employee', async () => {
    const res = await request(app).get('/api/admin/users').set(ADMIN);
    const linked = res.body.find(u => u.employee_id === emp1);
    expect(linked).toMatchObject({ employee_office_id: expect.stringMatching(/^EMP9/), employee_name: expect.stringContaining('ZZLink') });
  });

  it("the picker lists this company's current employees with their login, and no one else's", async () => {
    const res = await request(app).get('/api/admin/users/employee-options').set(ADMIN);
    expect(res.status).toBe(200);
    const ids = res.body.map(e => e.id);
    expect(ids).toEqual(expect.arrayContaining([emp1, emp2]));
    expect(ids).not.toContain(empOther);
    expect(ids).not.toContain(empDeleted);
    expect(res.body.find(e => e.id === emp1).linked_user_email).toMatch(/^zz\.link\./);
  });

  it('the picker is admin-only', async () => {
    const res = await request(app).get('/api/admin/users/employee-options')
      .set({ 'x-test-user': JSON.stringify({ roles: ['hr'] }) });
    expect(res.status).toBe(403);
  });
});

describe('rename', () => {
  let userId;
  beforeAll(async () => { userId = (await create({ name: 'ZZLink Before' })).body.user.id; });

  it('changes the display name, trimmed', async () => {
    expect((await edit(userId, { name: '  HR  ' })).status).toBe(200);
    expect((await userRow(userId)).name).toBe('HR');
  });

  it('refuses a blank name and keeps the old one', async () => {
    for (const name of ['', '   ', null]) {
      const res = await edit(userId, { name });
      expect(res.status).toBe(400);
    }
    expect((await userRow(userId)).name).toBe('HR');
  });

  it('an edit without name leaves it alone', async () => {
    expect((await edit(userId, { department: 'HR' })).status).toBe(200);
    expect((await userRow(userId)).name).toBe('HR');
  });
});
