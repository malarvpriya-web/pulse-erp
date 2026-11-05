/**
 * New employee logins get a per-account random password nobody knows.
 *
 * Both employee-creation paths provision a sign-in through createEmployeeLogin:
 *   · Add Employee       — POST /employees
 *   · Recruitment hire   — recruitmentRepository.hireCandidate()
 * Every such account used to open with the SAME password ('Welcome@123', or
 * DEFAULT_EMPLOYEE_PASSWORD), so anyone who knew the convention could sign in
 * as a new hire. Now each gets 32 CSPRNG bytes, hashed and discarded.
 *
 * Proven here, for BOTH paths:
 *   · the shared default does not open the account;
 *   · the initial secret is unique per account and appears in no response,
 *     audit row or the database in plain text;
 *   · must_change_password, the employee role, company scope and the
 *     employee link are as before;
 *   · the employee can get in through "Forgot password?" (request → OTP →
 *     reset → sign in) — the e-mail itself is stubbed, everything else is real;
 *   · an address that already has an account keeps that account untouched.
 *
 * The plaintext initial secret is observed by spying on bcrypt.hash (calls
 * through to the real implementation). Fixtures: test company 999936, deleted
 * by captured id.
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

vi.mock('../middlewares/auth.middleware.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    verifyToken: (req, res, next) => {
      const raw = req.headers['x-test-user'];
      if (!raw) return res.status(401).json({ error: 'Unauthorized' });
      const u = JSON.parse(raw);
      req.user  = { id: null, userId: null, roles: u.roles, role: u.roles[0], company_id: u.company_id };
      req.scope = { company_id: u.company_id };
      next();
    },
  };
});
vi.mock('../utils/mailer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sendPasswordResetOTP: vi.fn(async () => undefined),
}));

const { default: pool }                  = await import('../config/db.js');
const { default: employeeRoutes }        = await import('../employees/employee.routes.js');
const { default: recruitmentRepository } = await import('../modules/recruitment/repositories/recruitment.repository.js');
const { requestPasswordReset, verifyResetOtp, resetPassword, loginUser } = await import('../auth/auth.service.js');
const { default: bcrypt }                = await import('bcryptjs');

// Real bcrypt, real HTTP and shared tables: under the 4-worker suite a test
// that takes 1s alone can blow vitest's 5s default.
vi.setConfig({ testTimeout: 20000 });

const COMPANY = 999936;
// Both spellings the old code would have used.
const SHARED_DEFAULTS = [...new Set(['Welcome@123', process.env.DEFAULT_EMPLOYEE_PASSWORD].filter(Boolean))];
const HR = { 'x-test-user': JSON.stringify({ roles: ['hr'], company_id: COMPANY }) };
const stamp = Date.now();
let seq = 0;
const nextEmail = (kind) => `zz.initpw.${kind}.${stamp}.${++seq}@example.com`;

const app = express();
app.use(express.json());
app.use('/api/employees', employeeRoutes);

const created = { employees: [], users: [], candidates: [], jobs: [] };
let dept, desig, jobId;
// Database clock at suite start: audit rows from this run are newer than this.
let since;

/** Run `fn`, returning what it returned plus every plaintext bcrypt.hash saw. */
async function capturingHashes(fn) {
  const spy = vi.spyOn(bcrypt, 'hash');
  try {
    const result = await fn();
    return { result, hashed: spy.mock.calls.map(c => c[0]) };
  } finally {
    spy.mockRestore();
  }
}

async function addViaForm(extra = {}) {
  const body = {
    first_name: 'ZZIP', last_name: `Form${++seq}`, company_email: nextEmail('form'),
    department: dept, designation: desig, status: 'Active', joining_date: '2026-06-01',
    // mandatory on Add Employee since §202
    account_number: '123456789012', ifsc_code: 'HDFC0001234', current_address: '1 Fixture Street', ...extra,
  };
  const { result: res, hashed } = await capturingHashes(() =>
    request(app).post('/api/employees').set(HR).send(body));
  if (res.body?.id != null) created.employees.push(res.body.id);
  return { res, hashed, email: (extra.personal_email || body.company_email).toLowerCase(), body };
}

async function hireViaRecruitment(email = nextEmail('hire')) {
  const { rows: [cand] } = await pool.query(
    `INSERT INTO candidates (company_id, full_name, email, phone, applied_job_id)
     VALUES ($1, $2, $3, '9000000000', $4) RETURNING id`,
    [COMPANY, `ZZIP Hire${++seq}`, email, jobId]);
  created.candidates.push(cand.id);
  const { result, hashed } = await capturingHashes(() =>
    recruitmentRepository.hireCandidate(cand.id, COMPANY));
  created.employees.push(result.employee.id);
  return { result, hashed, email: email.toLowerCase() };
}

const userFor = async (employeeId) => (await pool.query(
  `SELECT * FROM users WHERE employee_id = $1`, [employeeId])).rows[0];

async function anExistingAccount() {
  const email = nextEmail('existing');
  const hash = await bcrypt.hash('ZzExisting-Own-Pass-1', 10);
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, must_change_password)
     VALUES ('ZZIP Existing', $1, $2, 'employee', true, false) RETURNING *`, [email, hash]);
  created.users.push(u.id);
  return u;
}

const snapshotUser = async (id) => ({
  user:  (await pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0],
  roles: (await pool.query('SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id', [id])).rows,
  scope: (await pool.query('SELECT company_id, branch_id FROM user_scope WHERE user_id = $1 ORDER BY company_id', [id])).rows,
});

beforeAll(async () => {
  ({ rows: [{ t: since }] } = await pool.query(`SELECT LOCALTIMESTAMP - INTERVAL '1 minute' AS t`));
  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1, 'ZZIP Initial Password Fixture', 'ZZIP')
     ON CONFLICT (id) DO NOTHING`, [COMPANY]);
  ({ rows: [{ name: dept }] } = await pool.query(`SELECT name FROM master_departments  WHERE is_active ORDER BY id LIMIT 1`));
  ({ rows: [{ name: desig }] } = await pool.query(`SELECT name FROM master_designations WHERE is_active ORDER BY id LIMIT 1`));
  const { rows: [job] } = await pool.query(
    `INSERT INTO job_openings (company_id, job_title, department) VALUES ($1, 'ZZIP Technician', $2) RETURNING id`,
    [COMPANY, dept]);
  jobId = job.id;
  created.jobs.push(job.id);
});

/**
 * Cleanup statement, retried on a deadlock. Deleting candidates cascades into
 * a dozen child tables while the recruitment suites sweep candidates in
 * parallel; Postgres resolves the occasional deadlock by aborting one side,
 * and an aborted cleanup leaks this suite's fixtures. Retrying is safe: every
 * statement here is an idempotent DELETE by captured id.
 */
async function cleanupQuery(sql, params) {
  for (let attempt = 1; ; attempt++) {
    try { return await pool.query(sql, params); }
    catch (e) {
      if (e.code !== '40P01' || attempt >= 5) throw e;
      await new Promise(r => { setTimeout(r, 100 * attempt); });
    }
  }
}

afterAll(async () => {
  const emp = created.employees;
  const { rows } = await cleanupQuery(
    `SELECT id FROM users WHERE employee_id = ANY($1::int[]) OR id = ANY($2::int[])`, [emp, created.users]);
  const uids = rows.map(r => r.id);
  if (uids.length) {
    await cleanupQuery('DELETE FROM password_reset_otps WHERE user_id = ANY($1::int[])', [uids]);
    await cleanupQuery('DELETE FROM user_roles WHERE user_id = ANY($1::int[])', [uids]);
    await cleanupQuery('DELETE FROM user_scope WHERE user_id = ANY($1::int[])', [uids]);
    await cleanupQuery('DELETE FROM users      WHERE id      = ANY($1::int[])', [uids]);
  }
  if (emp.length) {
    await cleanupQuery('DELETE FROM employee_salary_assignments WHERE employee_id = ANY($1::int[])', [emp]);
    await cleanupQuery('DELETE FROM employees WHERE id = ANY($1::int[])', [emp]);
  }
  if (created.candidates.length) await cleanupQuery('DELETE FROM candidates WHERE id = ANY($1::int[])', [created.candidates]);
  if (created.jobs.length) await cleanupQuery('DELETE FROM job_openings WHERE id = ANY($1::int[])', [created.jobs]);
});

// Shared assertions for one freshly provisioned account.
async function expectRandomUnrevealedLogin({ employeeId, email, hashed, response }) {
  const user = await userFor(employeeId);
  expect(user, 'a login must be provisioned').toBeDefined();

  // Exactly one secret was hashed for the account: 43 base64url chars (32 bytes).
  expect(hashed).toHaveLength(1);
  const secret = hashed[0];
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(SHARED_DEFAULTS).not.toContain(secret);
  expect(await bcrypt.compare(secret, user.password_hash)).toBe(true);

  // The shared default does not open it.
  for (const d of SHARED_DEFAULTS) expect(await bcrypt.compare(d, user.password_hash)).toBe(false);
  await expect(loginUser(email, SHARED_DEFAULTS[0])).rejects.toThrow();

  // Never disclosed: not in the response, not stored in plain text, not in the audit trail.
  if (response) expect(JSON.stringify(response)).not.toContain(secret);
  const { rows: [{ n: plain }] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM users WHERE id = $1 AND to_jsonb(users)::text LIKE $2`, [user.id, `%${secret}%`]);
  expect(plain).toBe(0);
  const { rows: [{ n: audited }] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM audit_logs
      WHERE created_at >= $2 AND (new_data_json::text LIKE $1 OR old_data_json::text LIKE $1)`,
    [`%${secret}%`, since]);
  expect(audited).toBe(0);

  // Everything else about the account is as before.
  expect(user).toMatchObject({ email, employee_id: employeeId, company_id: COMPANY, role: 'employee',
                               is_active: true, must_change_password: true });
  const { rows: roles } = await pool.query(
    `SELECT LOWER(r.code) AS code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [user.id]);
  expect(roles.map(r => r.code)).toContain('employee');
  const { rows: scope } = await pool.query(
    `SELECT company_id, is_primary FROM user_scope WHERE user_id = $1`, [user.id]);
  expect(scope).toEqual([{ company_id: COMPANY, is_primary: true }]);
  return { user, secret };
}

async function expectForgotPasswordWorks(email, employeeId) {
  const sent = await requestPasswordReset(email);
  expect(sent.sent).toBe(true);
  const { rows: [otp] } = await pool.query(
    `SELECT o.otp FROM password_reset_otps o JOIN users u ON u.id = o.user_id
      WHERE u.employee_id = $1 AND o.used = false ORDER BY o.id DESC LIMIT 1`, [employeeId]);
  expect(otp, 'an OTP must be issued for the new account').toBeDefined();
  await verifyResetOtp(email, otp.otp);
  const chosen = `ZzIp-Chosen-${seq}-Pass!`;
  await resetPassword(email, otp.otp, chosen);
  const session = await loginUser(email, chosen);
  expect(session.user?.employee_id ?? session.employee_id).toBe(employeeId);
  const after = await userFor(employeeId);
  expect(after.must_change_password).toBe(false);
}

// ── Add Employee ──────────────────────────────────────────────────────────────
describe('Add Employee (POST /employees)', () => {
  it('provisions a login with a random, unrevealed, non-default password', async () => {
    const { res, hashed, email } = await addViaForm();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.login).toEqual({ email, created: true });
    await expectRandomUnrevealedLogin({ employeeId: res.body.id, email, hashed, response: res.body });
  });

  it('two new accounts never share an initial password', async () => {
    const a = await addViaForm();
    const b = await addViaForm();
    expect(a.hashed).toHaveLength(1);
    expect(b.hashed).toHaveLength(1);
    expect(a.hashed[0]).not.toBe(b.hashed[0]);
  });

  it('the new employee can set a password and sign in through "Forgot password?"', async () => {
    const { res, email } = await addViaForm();
    await expectForgotPasswordWorks(email, res.body.id);
  });

  it('an address that already has an account: no new login, and the existing one is untouched', async () => {
    const existing = await anExistingAccount();
    const before = await snapshotUser(existing.id);
    const { res, hashed } = await addViaForm({ personal_email: existing.email });
    expect(res.status).toBe(200);
    expect(res.body.login).toBeUndefined();
    expect(hashed).toEqual([]);                      // nothing was hashed: no password set anywhere
    expect(await snapshotUser(existing.id)).toEqual(before);
    expect(await bcrypt.compare('ZzExisting-Own-Pass-1', before.user.password_hash)).toBe(true);
    const { rows } = await pool.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [existing.email]);
    expect(rows).toHaveLength(1);
  });
});

// ── Recruitment hire ──────────────────────────────────────────────────────────
describe('Recruitment hire (hireCandidate)', () => {
  it('provisions a login with a random, unrevealed, non-default password', async () => {
    const { result, hashed, email } = await hireViaRecruitment();
    expect(result.loginProvisioned).toBe(true);
    await expectRandomUnrevealedLogin({ employeeId: result.employee.id, email, hashed, response: result });
  });

  it('two hires never share an initial password', async () => {
    const a = await hireViaRecruitment();
    const b = await hireViaRecruitment();
    expect(a.hashed[0]).not.toBe(b.hashed[0]);
  });

  it('the hire can set a password and sign in through "Forgot password?"', async () => {
    const { result, email } = await hireViaRecruitment();
    await expectForgotPasswordWorks(email, result.employee.id);
  });

  it('a candidate whose address already has an account leaves that account untouched', async () => {
    const existing = await anExistingAccount();
    const before = await snapshotUser(existing.id);
    const { hashed } = await hireViaRecruitment(existing.email);
    expect(hashed).toEqual([]);
    expect(await snapshotUser(existing.id)).toEqual(before);
  });
});

// ── The source ────────────────────────────────────────────────────────────────
describe('the login service', () => {
  const src = readFileSync(resolve(here, '../employees/employee.service.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('no longer reads a shared default password from code or the environment', () => {
    expect(src).not.toMatch(/Welcome@123/);
    expect(src).not.toMatch(/DEFAULT_EMPLOYEE_PASSWORD/);
  });

  it('takes the initial secret from the shared CSPRNG helper, not its own copy', () => {
    expect(src).toMatch(/import \{ unrevealedInitialPasswordHash \} from "\.\.\/shared\/initialPassword\.js"/);
    expect(src).not.toMatch(/randomBytes|Math\.random/);
    const helper = readFileSync(resolve(here, '../shared/initialPassword.js'), 'utf8');
    expect(helper).toMatch(/crypto\.randomBytes\(32\)/);
    expect(helper).not.toMatch(/Math\.random/);
  });
});
