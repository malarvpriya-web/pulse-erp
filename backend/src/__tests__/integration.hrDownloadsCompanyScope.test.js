/**
 * HR Documents (`hr_downloads`) — company scope fails CLOSED (§208).
 *
 * Every /hr/downloads endpoint and the Home resources list need a concrete
 * company. A login without one used to read, edit, count and delete every
 * company's forms through `($1::int IS NULL OR company_id = $1)`, and to
 * create rows with no company. Now: 403 before any SQL runs.
 *
 * Creating a form records the uploader's employees.id in created_by (it FKs
 * employees), never the users.id; a login with no employee in the company is
 * refused.
 *
 * Real routers and database; two throwaway companies, synthetic employees,
 * forms and two company-less logins only — all removed afterwards.
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

const { default: pool }       = await import('../config/db.js');
const { verifyToken }         = await import('../middlewares/auth.middleware.js');
const { buildApp }            = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { default: hrRoutes }   = await import('../modules/hr/hr.routes.js');
const { default: homeRoutes } = await import('../home/home.routes.js');

const app = buildApp(['/api/hr', verifyToken, hrRoutes], ['/api/home', homeRoutes]);

const PREFIX = 'ZZHRDL';
const TITLE = `${PREFIX} form`;
let co, other, hr, otherHr, noCoHr, noCoSuper, hrNoLink, hrCross;
const ROW = {}, E = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);
const row = async (id) => (await pool.query(`SELECT * FROM hr_downloads WHERE id = $1`, [id])).rows[0];

async function addForm(company, suffix) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO hr_downloads (company_id, title, category, description, file_url, visible_to)
     VALUES ($1, $2, 'General', '', 'https://drive.google.com/file/d/zz/view', 'all') RETURNING id`,
    [company.companyId, `${TITLE} ${suffix}`]);
  return r.id;
}

/** A login whose users row and token carry no company (and no user_scope row). */
async function noCompanyLogin(company, label, roleCode) {
  const u = await addUser(pool, company, { label, roleCode });
  await pool.query(`UPDATE users SET company_id = NULL WHERE id = $1`, [u.userId]);
  return {
    userId: u.userId,
    token: () => jwt.sign({ userId: u.userId, role: roleCode, company_id: null, employee_id: null, name: label },
      process.env.JWT_SECRET, { expiresIn: '1h' }),
  };
}

async function addEmployee(company, code) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date)
     VALUES ($1, $2, $2, 'Fixture', 'Active', '2025-04-01') RETURNING id`, [company.companyId, code]);
  return r.id;
}
const link = (u, employeeId) => pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [employeeId, u.userId]);
async function sweepEmployees(companyId) {
  await pool.query(`UPDATE users SET employee_id = NULL WHERE employee_id IN (SELECT id FROM employees WHERE company_id = $1)`, [companyId]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [companyId]);
}
const formCount = async () => (await pool.query(`SELECT count(*)::int n FROM hr_downloads WHERE title LIKE $1`, [`${PREFIX}%`])).rows[0].n;

async function sweepForms() {
  await pool.query(`DELETE FROM hr_downloads WHERE title LIKE $1`, [`${PREFIX}%`]);
}
async function dropLogin(u) {
  for (const t of ['audit_logs', 'access_denials', 'notifications', 'user_scope']) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [u.userId]).catch(() => {});
  }
  await pool.query(`DELETE FROM user_roles WHERE user_id = $1`, [u.userId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [u.userId]);
}

beforeAll(async () => {
  await sweepForms();
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'zzhrdl%@test.invalid' AND company_id IS NULL)`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zzhrdl%@test.invalid' AND company_id IS NULL`);
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweepEmployees(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  hr = await addUser(pool, co, { label: 'hr', roleCode: 'hr_manager' });
  otherHr = await addUser(pool, other, { label: 'hr', roleCode: 'hr_manager' });
  // The HR user's employee id must differ from its users.id, or the old bug
  // (users.id written into created_by) would pass unnoticed.
  E.H = await addEmployee(co, 'EMP001');
  while (E.H === hr.userId) E.H = await addEmployee(co, `EMP${String(E.H + 1).padStart(3, '0')}`);
  await link(hr, E.H);
  E.X = await addEmployee(other, 'EMP001');
  hrNoLink = await addUser(pool, co, { label: 'hrnolink', roleCode: 'hr_manager' });
  hrCross = await addUser(pool, co, { label: 'hrcross', roleCode: 'hr_manager' }); await link(hrCross, E.X);
  noCoHr = await noCompanyLogin(co, 'nocohr', 'hr_manager');
  noCoSuper = await noCompanyLogin(co, 'nocosa', 'super_admin');
  ROW.A = await addForm(co, 'A');
  ROW.B = await addForm(other, 'B');
}, 60000);

afterAll(async () => {
  await sweepForms();
  for (const u of [noCoHr, noCoSuper]) if (u) await dropLogin(u);
  for (const c of [co, other]) if (c) { await sweepEmployees(c.companyId); await dropIsolatedCompany(pool, c.companyId); }
}, 60000);

describe('permitted access inside the company', () => {
  it('HR creates a form in its own company, credited to its employee record', async () => {
    expect(E.H).not.toBe(hr.userId);
    const made = await call(hr, 'post', '/api/hr/downloads')
      .send({ title: `${TITLE} new`, file_url: 'https://drive.google.com/file/d/zz2/view', company_id: other.companyId, created_by: hr.userId });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ company_id: co.companyId, created_by: E.H, title: `${TITLE} new` });
    expect(await row(made.body.id)).toMatchObject({ company_id: co.companyId, created_by: E.H });
    expect((await call(hr, 'get', '/api/hr/downloads')).body.some(r => r.id === made.body.id)).toBe(true);
    expect((await call(otherHr, 'get', '/api/hr/downloads')).body.some(r => r.id === made.body.id)).toBe(false);
    expect((await call(hr, 'delete', `/api/hr/downloads/${made.body.id}`)).status).toBe(200);
  });

  it('a login with no linked employee, or one from another company, creates nothing', async () => {
    const before = await formCount();
    for (const who of [hrNoLink, hrCross]) {
      const r = await call(who, 'post', '/api/hr/downloads').send({ title: `${TITLE} unlinked`, file_url: 'https://drive.google.com/file/d/zz4/view' });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'No employee record is linked to this account' });
    }
    expect(await formCount()).toBe(before);
  });

  it('HR lists, edits, counts and deletes only within its own company', async () => {
    const list = await call(hr, 'get', '/api/hr/downloads');
    expect(list.status).toBe(200);
    const ours = list.body.filter(r => r.title.startsWith(PREFIX)).map(r => r.id);
    expect(ours).toEqual([ROW.A]);

    expect((await call(hr, 'patch', `/api/hr/downloads/${ROW.A}`).send({ description: 'edited' })).status).toBe(200);
    expect((await call(hr, 'patch', `/api/hr/downloads/${ROW.A}/increment`)).status).toBe(200);
    const a = await row(ROW.A);
    expect(a).toMatchObject({ description: 'edited', download_count: 1 });

    const spare = await addForm(co, 'spare');
    expect((await call(hr, 'delete', `/api/hr/downloads/${spare}`)).status).toBe(200);
    expect(await row(spare)).toBeUndefined();
  });

  it('the Home resources list shows only the caller\'s company', async () => {
    const r = await call(hr, 'get', '/api/home/resources');
    expect(r.status).toBe(200);
    expect(r.body.filter(x => x.name.startsWith(PREFIX)).map(x => x.id)).toEqual([ROW.A]);
  });
});

describe('cross-company isolation', () => {
  it('another company\'s form is not listed, edited, counted or deleted', async () => {
    const list = await call(otherHr, 'get', '/api/hr/downloads');
    expect(list.body.filter(r => r.title.startsWith(PREFIX)).map(r => r.id)).toEqual([ROW.B]);

    const before = await row(ROW.B);
    expect((await call(hr, 'patch', `/api/hr/downloads/${ROW.B}`).send({ title: 'hijacked' })).status).toBe(404);
    expect((await call(hr, 'patch', `/api/hr/downloads/${ROW.B}/increment`)).status).toBe(404);
    expect((await call(hr, 'delete', `/api/hr/downloads/${ROW.B}`)).status).toBe(404);
    expect(await row(ROW.B)).toEqual(before);
  });
});

describe('no company context fails closed', () => {
  it.each([['hr_manager', () => noCoHr], ['super_admin', () => noCoSuper]])('%s without a company is refused on every endpoint', async (_role, who) => {
    const u = who();
    const before = { A: await row(ROW.A), B: await row(ROW.B) };
    const { rows: [{ n: countBefore }] } = await pool.query(`SELECT count(*)::int n FROM hr_downloads WHERE title LIKE $1`, [`${PREFIX}%`]);

    const responses = [
      await call(u, 'get', '/api/hr/downloads'),
      await call(u, 'post', '/api/hr/downloads').send({ title: `${TITLE} orphan`, file_url: 'https://drive.google.com/file/d/zz3/view' }),
      await call(u, 'patch', `/api/hr/downloads/${ROW.A}`).send({ title: 'hijacked' }),
      await call(u, 'patch', `/api/hr/downloads/${ROW.B}/increment`),
      await call(u, 'delete', `/api/hr/downloads/${ROW.B}`),
      await call(u, 'get', '/api/home/resources'),
    ];
    for (const r of responses) {
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'No company context for this login' });
    }
    expect(await row(ROW.A)).toEqual(before.A);
    expect(await row(ROW.B)).toEqual(before.B);
    const { rows: [{ n: countAfter }] } = await pool.query(`SELECT count(*)::int n FROM hr_downloads WHERE title LIKE $1`, [`${PREFIX}%`]);
    expect(countAfter).toBe(countBefore);
  });
});
