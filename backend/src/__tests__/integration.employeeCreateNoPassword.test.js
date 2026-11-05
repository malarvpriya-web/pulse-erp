/**
 * POST /employees must never return a password.
 *
 * Creating an employee auto-provisions a sign-in account. The service used to
 * return that account's temporary password, and the route sent it back in the
 * response body for Add Employee to display. Fixed at the source
 * (createEmployeeLogin returns { email, created }) with a backstop on the way
 * out (withoutCredentials in the controller).
 *
 * The replacement is the existing flow: the new employee uses "Forgot
 * password?" on the sign-in page. That flow is run end to end here for a freshly
 * created account, so the fix is not "the employee can no longer get in".
 *
 * Real database and real routers; only verifyToken is stubbed (caller from a
 * test header) and the reset e-mail is not actually sent. Fixtures live in test
 * company 999935 and are deleted by captured id.
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
// No real e-mail from a test. Everything else in the reset flow is real.
vi.mock('../utils/mailer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sendPasswordResetOTP: vi.fn(async () => undefined),
}));

const { default: pool }           = await import('../config/db.js');
const { default: employeeRoutes } = await import('../employees/employee.routes.js');
const { withoutCredentials }      = await import('../employees/employee.controller.js');
const { createEmployeeLogin }     = await import('../employees/employee.service.js');
const { requestPasswordReset, verifyResetOtp, resetPassword, loginUser } =
  await import('../auth/auth.service.js');
const { default: bcrypt }         = await import('bcryptjs');

const COMPANY = 999935;
const DEFAULT_PASSWORD = process.env.DEFAULT_EMPLOYEE_PASSWORD || 'Welcome@123';
const HR = { 'x-test-user': JSON.stringify({ roles: ['hr'], company_id: COMPANY }) };

const app = express();
app.use(express.json());
app.use('/api/employees', employeeRoutes);

const created = [];
let dept, desig;
const stamp = Date.now();
let seq = 0;

const newHire = (extra = {}) => {
  seq += 1;
  return {
    first_name: 'ZZNP', last_name: `Hire${seq}`,
    company_email: `zz.nopw.${stamp}.${seq}@example.com`,
    department: dept, designation: desig, status: 'Active', joining_date: '2026-06-01',
    // mandatory on Add Employee since §202
    account_number: '123456789012', ifsc_code: 'HDFC0001234', current_address: '1 Fixture Street',
    ...extra,
  };
};

async function hire(body, headers = HR) {
  const res = await request(app).post('/api/employees').set(headers).send(body);
  if (res.body?.id != null) created.push(res.body.id);
  return res;
}

/** Every key at every depth, for "no credential-shaped key anywhere". */
function allKeys(v, out = []) {
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { out.push(k); allKeys(x, out); }
  }
  return out;
}

function expectNoPassword(res) {
  const text = JSON.stringify(res.body ?? {});
  expect(text).not.toContain(DEFAULT_PASSWORD);
  expect(allKeys(res.body).filter(k => /^(password|password_hash|temp_password|temporary_password|otp|dev_otp)$/i.test(k)))
    .toEqual([]);
  expect(res.text ?? '').not.toContain(DEFAULT_PASSWORD);
}

beforeAll(async () => {
  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1, 'ZZNP No Password Fixture', 'ZZNP')
     ON CONFLICT (id) DO NOTHING`, [COMPANY]);
  ({ rows: [{ name: dept }] } = await pool.query(`SELECT name FROM master_departments  WHERE is_active ORDER BY id LIMIT 1`));
  ({ rows: [{ name: desig }] } = await pool.query(`SELECT name FROM master_designations WHERE is_active ORDER BY id LIMIT 1`));
});

afterAll(async () => {
  if (!created.length) return;
  const { rows } = await pool.query('SELECT id FROM users WHERE employee_id = ANY($1::int[])', [created]);
  const uids = rows.map(r => r.id);
  if (uids.length) {
    await pool.query('DELETE FROM password_reset_otps WHERE user_id = ANY($1::int[])', [uids]);
    await pool.query('DELETE FROM user_roles WHERE user_id = ANY($1::int[])', [uids]);
    await pool.query('DELETE FROM user_scope WHERE user_id = ANY($1::int[])', [uids]);
    await pool.query('DELETE FROM users      WHERE id      = ANY($1::int[])', [uids]);
  }
  await pool.query('DELETE FROM employees WHERE id = ANY($1::int[])', [created]);
});

// ── The response ──────────────────────────────────────────────────────────────
describe('POST /employees response', () => {
  let res, body;
  beforeAll(async () => { body = newHire(); res = await hire(body); });

  it('creates the employee', () => {
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.id).toEqual(expect.any(Number));
    expect(res.body.company_id).toBe(COMPANY);
  });

  it('contains no password — not as a value, not under any key, at any depth', () => {
    expectNoPassword(res);
  });

  it('still tells the client a login was created, and for which address', () => {
    expect(res.body.login).toEqual({ email: body.company_email, created: true });
  });
});

// ── The account behind it ─────────────────────────────────────────────────────
describe('login-account linking is unchanged', () => {
  let empId, user;
  beforeAll(async () => {
    const res = await hire(newHire());
    empId = res.body.id;
    ({ rows: [user] } = await pool.query(
      `SELECT id, email, role, company_id, employee_id, is_active, must_change_password, password_hash
         FROM users WHERE employee_id = $1`, [empId]));
  });

  it('links one active users row to the employee, in the employee\'s company', () => {
    expect(user).toMatchObject({ employee_id: empId, company_id: COMPANY, is_active: true, role: 'employee' });
  });

  it('grants the employee role and a primary company scope', async () => {
    const { rows: roles } = await pool.query(
      `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [user.id]);
    expect(roles.map(r => r.code.toLowerCase())).toContain('employee');
    const { rows: scope } = await pool.query(
      `SELECT company_id, is_primary FROM user_scope WHERE user_id = $1`, [user.id]);
    expect(scope).toEqual([{ company_id: COMPANY, is_primary: true }]);
  });

  it('still forces a password change at first sign-in', () => {
    expect(user.must_change_password).toBe(true);
  });

  it('the account does not open with the old shared default password', async () => {
    // Initial passwords are now per-account random and never revealed; the
    // employee gets in through "Forgot password?" (next test).
    expect(await bcrypt.compare(DEFAULT_PASSWORD, user.password_hash)).toBe(false);
  });

  it('the new employee can set their own password through "Forgot password?"', async () => {
    const sent = await requestPasswordReset(user.email);
    expect(sent.sent).toBe(true);
    const { rows: [otp] } = await pool.query(
      `SELECT otp FROM password_reset_otps WHERE user_id = $1 AND used = false ORDER BY id DESC LIMIT 1`, [user.id]);
    expect(otp).toBeDefined();
    await verifyResetOtp(user.email, otp.otp);
    await resetPassword(user.email, otp.otp, 'ZzNp-Own-Pass-2026!');
    const { rows: [after] } = await pool.query(
      `SELECT password_hash, must_change_password FROM users WHERE id = $1`, [user.id]);
    expect(await bcrypt.compare('ZzNp-Own-Pass-2026!', after.password_hash)).toBe(true);
    expect(after.must_change_password).toBe(false);
    const session = await loginUser(user.email, 'ZzNp-Own-Pass-2026!');
    expect(JSON.stringify(session)).not.toContain('ZzNp-Own-Pass-2026!');
    expect(session.user?.employee_id ?? session.employee_id).toBe(empId);
  });
});

describe('when the address already has an account', () => {
  it('creates the employee, creates no second account, and returns no login and no password', async () => {
    const first = newHire();
    await hire(first);
    // Same address as the personal e-mail of a second hire: the login is skipped.
    const res = await hire(newHire({ personal_email: first.company_email }));
    expect(res.status).toBe(200);
    expect(res.body.login).toBeUndefined();
    expectNoPassword(res);
  });
});

// ── Errors and denials ────────────────────────────────────────────────────────
describe('error and denied responses carry no password either', () => {
  it('a validation failure', async () => {
    const res = await hire({ first_name: 'ZZNP', company_email: `zz.nopw.${stamp}.bad@example.com` });
    expect(res.status).toBe(400);
    expectNoPassword(res);
  });

  it('a duplicate company e-mail', async () => {
    const dup = newHire();
    await hire(dup);
    const res = await hire({ ...newHire(), company_email: dup.company_email });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expectNoPassword(res);
  });

  it('a caller without an HR role', async () => {
    const res = await hire(newHire(), { 'x-test-user': JSON.stringify({ roles: ['employee'], company_id: COMPANY }) });
    expect(res.status).toBe(403);
    expectNoPassword(res);
  });
});

// ── Audit trail ───────────────────────────────────────────────────────────────
describe('the audit trail', () => {
  it('the create entry carries no password', async () => {
    const res = await hire(newHire());
    const id = String(res.body.id);
    // logAudit is fire-and-forget; give it a moment to land.
    let rows = [];
    for (let i = 0; i < 20 && !rows.length; i++) {
      ({ rows } = await pool.query(
        `SELECT old_data_json, new_data_json FROM audit_logs
          WHERE module_name = 'employees' AND reference_id::text = $1`, [id]));
      if (!rows.length) await new Promise(r => setTimeout(r, 100));
    }
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(JSON.stringify(r)).not.toContain(DEFAULT_PASSWORD);
  });
});

// ── The pieces ────────────────────────────────────────────────────────────────
describe('createEmployeeLogin (also used by the recruitment hire path)', () => {
  it('returns { email, created } and nothing else', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [emp] } = await client.query(
        `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email)
         VALUES ($1, 'EMP99993599', 'ZZNP', 'Direct', $2) RETURNING *`,
        [COMPANY, `zz.nopw.${stamp}.direct@example.com`]);
      const login = await createEmployeeLogin(client, emp);
      expect(login).toEqual({ email: `zz.nopw.${stamp}.direct@example.com`, created: true });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('withoutCredentials', () => {
  it('removes credential keys at any depth, in objects and arrays', () => {
    const out = withoutCredentials({
      id: 1, password: 'x',
      login: { email: 'a@b.c', password: 'x', created: true, nested: [{ password_hash: 'h', otp: '1', keep: 2 }] },
      list: [{ temp_password: 't', dev_otp: '9', name: 'n' }],
    });
    expect(out).toEqual({
      id: 1,
      login: { email: 'a@b.c', created: true, nested: [{ keep: 2 }] },
      list: [{ name: 'n' }],
    });
  });

  it('keeps must_change_password, which is a flag and not a credential', () => {
    expect(withoutCredentials({ must_change_password: true })).toEqual({ must_change_password: true });
  });

  it('leaves dates, nulls and primitives alone', () => {
    const d = new Date('2026-06-01T00:00:00Z');
    expect(withoutCredentials({ joined: d, x: null, n: 3 })).toEqual({ joined: d, x: null, n: 3 });
    expect(withoutCredentials(null)).toBeNull();
    expect(withoutCredentials('s')).toBe('s');
  });
});
