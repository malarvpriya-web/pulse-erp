/**
 * Company email is an HR field. Login email is an authentication identity.
 * Editing the first must never move the second.
 *
 * Storage (verified 2026-10-12):
 *   employees.company_email  unique per company (employees_company_email_uniq,
 *                            lower+trim), editable on Edit Employee
 *   users.email              the login; globally unique (users_email_key);
 *                            looked up by loginUser and password reset
 *   users.employee_id        THE link between a login and an employee
 *
 * Before this suite, five places used `company_email = users.email` as if it
 * were that link — the token's employee_id (auth.service resolveEmployeeId),
 * own-document access (secureFiles), notification routing (three resolvers),
 * the 2FA status list and the GDPR purge. Each made an HR edit of a company
 * email an identity change. These tests drive the REAL paths: updateEmployee,
 * loginUser (token claims), and HEAD /files/:name through verifyToken.
 *
 * Fixtures are committed in two registry tenants (testTenantIds.contract) and
 * removed in afterAll; no real account is touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { default: bcrypt } = await import('bcryptjs');
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const jwt = (await import('jsonwebtoken')).default;
const { updateEmployee } = await import('../employees/employee.service.js');
const { loginUser } = await import('../auth/auth.service.js');
const { getMyPayslipList } = await import('../modules/payroll/payroll.service.js');
const { callerIdentity } = await import('../shared/scope.js');
const { default: filesRouter } = await import('../modules/files/secureFiles.routes.js');
const { LOCAL_UPLOAD_DIR } = await import('../services/StorageService.js');

const OWN = 999923;
const FOREIGN = 999924;
const PW = 'Zz-Ident-Test-9!';
const DOC = `zz_ident_${process.pid}_pan.pdf`;
const fx = {};

const app = express();
app.use('/api/files', filesRouter);

const user = async (id) => (await pool.query(
  `SELECT id, email, password_hash, employee_id, google_id, is_active FROM users WHERE id = $1`, [id])).rows[0];
const claims = (token) => jwt.decode(token);

async function cleanup() {
  const users = `SELECT id FROM users WHERE email LIKE 'zz.ident.%@example.com'`;
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.ident.%@example.com'`);
  await pool.query(`DELETE FROM payroll_runs WHERE employee_id IN (SELECT id FROM employees WHERE company_id IN (${OWN}, ${FOREIGN}))`);
  await pool.query(`DELETE FROM employees WHERE company_id IN (${OWN}, ${FOREIGN})`);
  await pool.query(`DELETE FROM companies WHERE id IN (${OWN}, ${FOREIGN})`);
}

beforeAll(async () => {
  await cleanup();
  for (const [id, name, code] of [[OWN, 'ZZ Ident Own', 'ZZIO'], [FOREIGN, 'ZZ Ident Foreign', 'ZZIF']]) {
    await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,$2,$3)`, [id, name, code]);
  }
  const dept = (await pool.query(`SELECT name FROM master_departments WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)).rows[0]?.name;
  const desig = (await pool.query(`SELECT name FROM master_designations WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)).rows[0]?.name;
  const emp = async (cid, code, email, pan = null) => (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation,
                            status, joining_date, pan_file)
     VALUES ($1,$2,'Zz','Ident',$3,$4,$5,'Active','2026-01-01',$6) RETURNING id`,
    [cid, code, email, dept, desig, pan])).rows[0].id;
  const hash = await bcrypt.hash(PW, 4);
  const login = async (email, cid, employeeId) => {
    const id = (await pool.query(
      `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
       VALUES ('Zz Ident', $1, $2, 'employee', true, $3, $4) RETURNING id`,
      [email, hash, cid, employeeId])).rows[0].id;
    await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [id, cid]);
    return id;
  };

  // A: an employee whose login is their company email, and who owns a document.
  fx.a = await emp(OWN, 'EMP923001', 'zz.ident.a@example.com', `/uploads/${DOC}`);
  fx.ua = await login('zz.ident.a@example.com', OWN, fx.a);
  // X: an employee with NO login.
  fx.x = await emp(OWN, 'EMP923002', 'zz.ident.x@example.com');
  // U: a login linked to NO employee (an admin-created account, say).
  fx.uu = await login('zz.ident.unlinked@example.com', OWN, null);
  // P: a colleague's login in the SAME company, linked to no employee here.
  fx.up = await login('zz.ident.peer@example.com', OWN, null);
  // F: another tenant's employee + login.
  fx.f = await emp(FOREIGN, 'EMP924001', 'zz.ident.f@example.com');
  fx.uf = await login('zz.ident.f@example.com', FOREIGN, fx.f);

  fx.uaBefore = await user(fx.ua);
  writeFileSync(join(LOCAL_UPLOAD_DIR, DOC), 'zz');
});

afterAll(async () => {
  rmSync(join(LOCAL_UPLOAD_DIR, DOC), { force: true });
  await cleanup();
});

const tokenFor = async (email) => (await loginUser(email, PW)).token;

// ═════════════════════════════════════════════════════════════════════════════
describe('editing company email leaves the login untouched', () => {
  it('the users row — email, password, link, Google id — is unchanged', async () => {
    await updateEmployee(fx.a, { company_email: 'zz.ident.a.renamed@example.com' }, OWN);
    const after = await user(fx.ua);
    expect(after).toEqual(fx.uaBefore);
    const { rows } = await pool.query(`SELECT company_email FROM employees WHERE id = $1`, [fx.a]);
    expect(rows[0].company_email).toBe('zz.ident.a.renamed@example.com');
  });

  it('the employee still signs in with the OLD login, as the same employee', async () => {
    const token = await tokenFor('zz.ident.a@example.com');
    expect(claims(token)).toMatchObject({ userId: fx.ua, employee_id: fx.a, email: 'zz.ident.a@example.com' });
  });

  it('the NEW company email is not a login', async () => {
    await expect(loginUser('zz.ident.a.renamed@example.com', PW)).rejects.toThrow(/Invalid email or password/);
  });

  it('the employee can still open their own documents after the edit', async () => {
    // secureFiles decided self-access by `users.email = company_email`, so this
    // edit used to lock A out of their own PAN card.
    const res = await request(app).head(`/api/files/${DOC}`)
      .set('Authorization', `Bearer ${await tokenFor('zz.ident.a@example.com')}`);
    expect(res.status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('a company email equal to someone else\'s login confers nothing', () => {
  it('pointing X\'s company email at an unlinked login does NOT make that login X', async () => {
    await updateEmployee(fx.x, { company_email: 'zz.ident.unlinked@example.com' }, OWN);
    const token = await tokenFor('zz.ident.unlinked@example.com');
    // Before the fix: employee_id === fx.x — an HR edit had just handed this
    // account X's self-service identity.
    expect(claims(token).employee_id).toBeNull();
    expect((await user(fx.uu)).employee_id).toBeNull();
  });

  it('pointing A\'s company email at a colleague\'s login gives that colleague no access to A\'s documents', async () => {
    await updateEmployee(fx.a, { company_email: 'zz.ident.peer@example.com' }, OWN);
    const res = await request(app).head(`/api/files/${DOC}`)
      .set('Authorization', `Bearer ${await tokenFor('zz.ident.peer@example.com')}`);
    // Before the fix: 200 — the colleague could open A's PAN card.
    expect(res.status).toBe(403);
  });

  it('…nor another tenant\'s login (company email is unique only per company)', async () => {
    await updateEmployee(fx.a, { company_email: 'zz.ident.f@example.com' }, OWN);
    const res = await request(app).head(`/api/files/${DOC}`)
      .set('Authorization', `Bearer ${await tokenFor('zz.ident.f@example.com')}`);
    // Also refused before the fix, by canReadFile's separate company check —
    // kept so the link and that check cannot both regress unnoticed.
    expect(res.status).toBe(403);
    // ...and the foreign login is still exactly who it was.
    expect(claims(await tokenFor('zz.ident.f@example.com'))).toMatchObject({ userId: fx.uf, employee_id: fx.f });
  });

  it('…and A still has their own access', async () => {
    const res = await request(app).head(`/api/files/${DOC}`)
      .set('Authorization', `Bearer ${await tokenFor('zz.ident.a@example.com')}`);
    expect(res.status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('"my" data follows the login link, never an email match', () => {
  it('My Payslips stays the linked employee when another record carries the login address', async () => {
    // Put A's login address into X's PERSONAL and COMPANY email: the old query
    // (id OR company_email OR personal_email, unordered LIMIT 1) could serve X.
    await updateEmployee(fx.x, { personal_email: 'zz.ident.a@example.com', company_email: 'zz.ident.x2@example.com' }, OWN);
    // My Payslips lists FINALISED runs only (2026-10-20 payroll audit — it used
    // to invent a computed figure for every month), so give both A and X one.
    for (const id of [fx.a, fx.x]) {
      await pool.query(
        `INSERT INTO payroll_runs (employee_id, month, year, status, period_label, gross, net_pay, total_deductions)
         VALUES ($1, 8, 2026, 'approved', 'August 2026', 1000, 1000, 0)
         ON CONFLICT (employee_id, month, year) WHERE employee_id IS NOT NULL AND month IS NOT NULL AND year IS NOT NULL DO NOTHING`, [id]);
    }
    const claim = claims(await tokenFor('zz.ident.a@example.com'));
    const slips = await getMyPayslipList(claim.email, claim.employee_id);
    expect(slips.length).toBeGreaterThan(0);
    expect(new Set(slips.map(s => s.employee_id))).toEqual(new Set([fx.a]));
  });

  it('an unlinked login has no payslips, whatever emails HR has typed', async () => {
    await updateEmployee(fx.x, { personal_email: 'zz.ident.unlinked@example.com' }, OWN);
    // Before the fix: X's payslip rows.
    const claim = claims(await tokenFor('zz.ident.unlinked@example.com'));
    expect(await getMyPayslipList(claim.email, claim.employee_id)).toEqual([]);
  });

  it('callerIdentity does not adopt an employee by company email', async () => {
    await updateEmployee(fx.x, { company_email: 'zz.ident.unlinked@example.com' }, OWN);
    const req = { user: { userId: fx.uu, email: 'zz.ident.unlinked@example.com', employee_id: null } };
    const who = await callerIdentity(req, pool, OWN);
    expect(who.employee_id).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('duplicate company email is refused within a company, never across', () => {
  it('a second employee of the same company cannot take the address (any case)', async () => {
    await updateEmployee(fx.a, { company_email: 'zz.ident.a@example.com' }, OWN);
    const err = await updateEmployee(fx.x, { company_email: 'ZZ.IDENT.A@example.com' }, OWN).catch(e => e);
    expect(err.statusCode).toBe(409);
  });

  it('another tenant may use the same company email, and nothing about A changes', async () => {
    await updateEmployee(fx.f, { company_email: 'zz.ident.a@example.com' }, FOREIGN);
    expect(await user(fx.ua)).toEqual(fx.uaBefore);
    expect(claims(await tokenFor('zz.ident.a@example.com')).employee_id).toBe(fx.a);
  });

  it('a foreign tenant cannot edit A\'s company email at all', async () => {
    const err = await updateEmployee(fx.a, { company_email: 'zz.ident.hijack@example.com' }, FOREIGN).catch(e => e);
    expect(err.statusCode).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('no code path treats company email as the login', () => {
  const read = (rel) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');
  /** A LOOKUP on the column against a bound value — not an assignment like the purge's SET. */
  const LOOKUP = (col) => new RegExp(
    String.raw`\b(WHERE|AND|OR|ON)\s+\(?\s*(LOWER\()?\s*(e\.)?` + col + String.raw`\s*\)?\s*=\s*(LOWER\()?\s*\$\d`, 'i');

  it('the lookup pattern catches the shapes that shipped', () => {
    // Guards the guard: these are the exact pre-fix statements.
    expect(`SELECT id FROM employees WHERE company_email=$1 LIMIT 1`).toMatch(LOOKUP('company_email'));
    expect(`WHERE id = $1\n OR (company_email IS NOT NULL AND LOWER(company_email) = LOWER($2))`).toMatch(LOOKUP('company_email'));
    expect(`OR (personal_email IS NOT NULL AND LOWER(personal_email) = LOWER($2))`).toMatch(LOOKUP('personal_email'));
    expect(`UPDATE employees SET first_name=$1, company_email=$2`).not.toMatch(LOOKUP('company_email'));
  });

  it('updateEmployee never writes the users table', () => {
    const src = read('employees/employee.service.js');
    const update = src.slice(src.indexOf('export const updateEmployee'), src.indexOf('export const deleteEmployee'));
    expect(update).not.toMatch(/UPDATE\s+users\b/i);
  });

  it.each([
    'auth/auth.service.js',
    'modules/files/secureFiles.routes.js',
    'jobs/crmFollowup.cron.js',
    'modules/crm/routes/crm.routes.js',
    'services/WorkflowNotificationService.js',
    'modules/admin/security.routes.js',
    'modules/projects/routes/projects.routes.js',
    'modules/projects/routes/tasks.routes.js',
    'modules/crm/services/opportunityConversion.service.js',
    'modules/payroll/payroll.service.js',
    'shared/scope.js',
  ])('%s has no company_email <-> login email match', (rel) => {
    const code = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/u\.email\s*=\s*e\.company_email|LOWER\(u\.email\)\s*=\s*LOWER\(e\.company_email\)/i);
    // A lookup (WHERE/AND/OR/ON …), not an assignment such as the purge's SET.
    expect(code).not.toMatch(LOOKUP('company_email'));
    expect(code).not.toMatch(LOOKUP('personal_email'));
  });
});
