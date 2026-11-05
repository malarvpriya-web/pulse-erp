/**
 * Login emails are case-insensitive — sign-in, registration, password reset,
 * account creation and uniqueness — against the live database.
 *
 * Before (2026-10-12): users.email was unique on the exact string and every
 * auth lookup was `email = $1`, so 'Asha@Acme.in' could not sign in as
 * 'asha@acme.in' and registration accepted both as two accounts. The customer
 * portal had the inverse bug and no portal account could sign in at all.
 *
 * The fix (migration 20261012000002 + shared/loginEmail.js): every write is
 * stored LOWER(BTRIM()), every lookup compares LOWER(BTRIM(email)) to a
 * normalised value, a UNIQUE index on that expression enforces it (global for
 * users, per company for portal accounts), and a trigger normalises any writer.
 * Existing rows were NOT rewritten — the "legacy" cases below prove a stored
 * mixed-case login still works and is left exactly as it was.
 *
 * Fixtures: registry tenants 999925/999926 and 'zz.case.*' addresses, removed
 * in afterAll. The mailer is mocked — a reset test must never send mail.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const mailer = vi.hoisted(() => ({ sendPasswordResetOTP: vi.fn(async () => {}) }));
vi.mock('../utils/mailer.js', async (orig) => ({ ...(await orig()), sendPasswordResetOTP: mailer.sendPasswordResetOTP }));

const { default: pool } = await import('../config/db.js');
const { default: bcrypt } = await import('bcryptjs');
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const jwt = (await import('jsonwebtoken')).default;
const auth = await import('../auth/auth.service.js');
const { createEmployeeLogin } = await import('../employees/employee.service.js');
const { default: portalRouter } = await import('../modules/servicedesk/routes/customer-portal.routes.js');
const { normalizeLoginEmail } = await import('../shared/loginEmail.js');

const CO_A = 999925;
const CO_B = 999926;
const PW = 'Zz-Case-Test-9!';
const fx = {};

const portal = express();
portal.use(express.json());
portal.use('/api/customer-portal', portalRouter);

const userRow = async (id) => (await pool.query(`SELECT id, email, password_hash FROM users WHERE id = $1`, [id])).rows[0];
const countKey = async (k) => Number((await pool.query(
  `SELECT COUNT(*) FROM users WHERE LOWER(BTRIM(email)) = $1`, [k])).rows[0].count);

/** A row exactly as a pre-migration writer left it: mixed case, trigger bypassed for THIS session only. */
async function legacyUser(email, companyId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL session_replication_role = replica`);
    const { rows: [u] } = await client.query(
      `INSERT INTO users (name, email, password_hash, role, is_active, company_id)
       VALUES ('Zz Case', $1, $2, 'employee', true, $3) RETURNING id`,
      [email, await bcrypt.hash(PW, 4), companyId]);
    await client.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [u.id, companyId]);
    await client.query('COMMIT');
    return u.id;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function cleanup() {
  const ids = `SELECT id FROM users WHERE LOWER(email) LIKE 'zz.case.%'`;
  await pool.query(`DELETE FROM password_reset_otps WHERE user_id IN (${ids})`);
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${ids})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${ids})`);
  await pool.query(`DELETE FROM users WHERE LOWER(email) LIKE 'zz.case.%'`);
  await pool.query(`DELETE FROM customer_portal_users WHERE company_id IN (${CO_A}, ${CO_B})`);
  await pool.query(`DELETE FROM employees WHERE company_id IN (${CO_A}, ${CO_B})`);
  // talent.routes.js seeds default interview questions for EVERY active company
  // when it is imported (integration.recruitmentRegression does, in parallel).
  // If that lands while these companies exist, interview_questions FKs them and
  // the DELETE below fails — and then fails on every later run too.
  await pool.query(`DELETE FROM interview_questions WHERE company_id IN (${CO_A}, ${CO_B})`);
  await pool.query(`DELETE FROM companies WHERE id IN (${CO_A}, ${CO_B})`);
}

beforeAll(async () => {
  await cleanup();
  for (const [id, name, code] of [[CO_A, 'ZZ Case A', 'ZZCA'], [CO_B, 'ZZ Case B', 'ZZCB']]) {
    await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,$2,$3)`, [id, name, code]);
  }
  fx.legacy = await legacyUser('ZZ.Case.Legacy@Example.COM', CO_A);
});

afterAll(async () => { await cleanup(); });

// ═════════════════════════════════════════════════════════════════════════════
describe('normalisation', () => {
  it('trims and lowercases; blank is null', () => {
    expect(normalizeLoginEmail('  Asha.Rao@ACME.in ')).toBe('asha.rao@acme.in');
    expect(normalizeLoginEmail('   ')).toBeNull();
    expect(normalizeLoginEmail(null)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('registration', () => {
  it('stores a mixed-case, padded address in normal form', async () => {
    const u = await auth.registerUser('Zz Case', '  ZZ.Case.Reg@Example.COM ', PW);
    expect(u.email).toBe('zz.case.reg@example.com');
    fx.reg = u.id;
  });

  it('refuses a case variant of an existing login with 409', async () => {
    const err = await auth.registerUser('Zz Case', 'zz.case.REG@example.com', PW).catch(e => e);
    expect(err.statusCode).toBe(409);
    expect(await countKey('zz.case.reg@example.com')).toBe(1);
  });

  it('refuses a case variant of a LEGACY mixed-case login too', async () => {
    const err = await auth.registerUser('Zz Case', 'zz.case.legacy@example.com', PW).catch(e => e);
    expect(err.statusCode).toBe(409);
  });

  it('two simultaneous registrations differing only by case create exactly one account', async () => {
    // Both pass the application's pre-check; the unique index decides.
    const results = await Promise.allSettled([
      auth.registerUser('Zz Case', 'ZZ.Case.Race@Example.com', PW),
      auth.registerUser('Zz Case', 'zz.case.race@EXAMPLE.COM', PW),
      auth.registerUser('Zz Case', ' zz.case.race@example.com', PW),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter(r => r.status === 'rejected')) expect(r.reason.statusCode).toBe(409);
    expect(await countKey('zz.case.race@example.com')).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('sign-in', () => {
  it.each(['zz.case.reg@example.com', 'ZZ.CASE.REG@EXAMPLE.COM', '  Zz.Case.Reg@Example.Com  '])(
    'signs in as %j', async (typed) => {
      const { token } = await auth.loginUser(typed, PW);
      expect(jwt.decode(token).userId).toBe(fx.reg);
    });

  it('a legacy mixed-case login signs in typed any way, and its stored address is left alone', async () => {
    for (const typed of ['zz.case.legacy@example.com', 'ZZ.Case.Legacy@Example.COM']) {
      expect(jwt.decode((await auth.loginUser(typed, PW)).token).userId).toBe(fx.legacy);
    }
    // last_login was written; the email was not — no real account is rewritten.
    expect((await userRow(fx.legacy)).email).toBe('ZZ.Case.Legacy@Example.COM');
  });

  it('a wrong password is still the generic error, whatever the case', async () => {
    await expect(auth.loginUser('ZZ.CASE.REG@example.com', 'nope')).rejects.toThrow(/Invalid email or password/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('password reset', () => {
  it('request, verify and reset each accept any case, and mail goes to the ACCOUNT address', async () => {
    mailer.sendPasswordResetOTP.mockClear();
    const { dev_otp } = await auth.requestPasswordReset('ZZ.Case.Legacy@EXAMPLE.com');
    expect(dev_otp).toMatch(/^\d{6}$/);
    expect(mailer.sendPasswordResetOTP).toHaveBeenCalledWith('ZZ.Case.Legacy@Example.COM', dev_otp);

    await expect(auth.verifyResetOtp('zz.case.legacy@example.com', dev_otp)).resolves.toEqual({ valid: true });
    await auth.resetPassword(' ZZ.CASE.LEGACY@EXAMPLE.COM ', dev_otp, 'Zz-New-Pass-77!');
    expect(jwt.decode((await auth.loginUser('zz.case.legacy@example.com', 'Zz-New-Pass-77!')).token).userId).toBe(fx.legacy);
    // Put the fixture back for later tests.
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [await bcrypt.hash(PW, 4), fx.legacy]);
  });

  it('an unknown address still answers "sent" and mails nothing', async () => {
    mailer.sendPasswordResetOTP.mockClear();
    expect(await auth.requestPasswordReset('ZZ.Case.Nobody@example.com')).toEqual({ sent: true });
    expect(mailer.sendPasswordResetOTP).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the database enforces it for every writer', () => {
  it('a raw INSERT is normalised by the trigger', async () => {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, is_active) VALUES ('Zz', ' ZZ.Case.Raw@Example.com ', 'x', 'employee', true) RETURNING email`);
    expect(u.email).toBe('zz.case.raw@example.com');
  });

  it('a raw INSERT of a case variant is refused by the case-insensitive index', async () => {
    const err = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, is_active) VALUES ('Zz', 'ZZ.CASE.REG@example.com', 'x', 'employee', true)`)
      .catch(e => e);
    expect(err.code).toBe('23505');
  });

  it('an UPDATE that does not touch email does not rewrite a legacy address', async () => {
    await pool.query(`UPDATE users SET name = 'Zz Case Renamed' WHERE id = $1`, [fx.legacy]);
    expect((await userRow(fx.legacy)).email).toBe('ZZ.Case.Legacy@Example.COM');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('tenant boundaries', () => {
  it('a login is global: another company cannot take a case variant of it', async () => {
    const err = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, is_active, company_id)
       VALUES ('Zz', 'Zz.Case.Reg@example.com', 'x', 'employee', true, $1)`, [CO_B]).catch(e => e);
    expect(err.code).toBe('23505');
  });

  it('Add Employee skips the login (no error, no hire rollback) when a case variant exists in ANY company', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [emp] } = await client.query(
        `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, status, joining_date)
         VALUES ($1,'EMP925001','Zz','Case','ZZ.CASE.REG@Example.com','Active','2026-01-01') RETURNING *`, [CO_B]);
      await expect(createEmployeeLogin(client, emp)).resolves.toBeNull();
      // The hire's transaction is still usable — not aborted by a 23505.
      await expect(client.query('SELECT 1')).resolves.toBeTruthy();
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  describe('customer portal accounts are unique per company', () => {
    beforeAll(async () => {
      const hash = await bcrypt.hash(PW, 4);
      for (const cid of [CO_A, CO_B]) {
        await pool.query(
          `INSERT INTO customer_portal_users (company_id, customer_name, email, password_hash)
           VALUES ($1, 'ZZ Customer', 'ZZ.Case.Portal@Example.com', $2)`, [cid, hash]);
      }
    });

    it('the same address in two companies is allowed; a case variant in ONE company is not', async () => {
      const err = await pool.query(
        `INSERT INTO customer_portal_users (company_id, customer_name, email, password_hash)
         VALUES ($1, 'ZZ Dup', 'zz.case.PORTAL@example.com', 'x')`, [CO_A]).catch(e => e);
      expect(err.code).toBe('23505');
    });

    it('portal sign-in works typed any way, inside the right company only', async () => {
      for (const email of ['zz.case.portal@example.com', 'ZZ.CASE.PORTAL@EXAMPLE.COM']) {
        const res = await request(portal).post('/api/customer-portal/auth/login').send({ email, password: PW, company_id: CO_A });
        expect(res.status, email).toBe(200);
        expect(jwt.decode(res.body.token).company_id).toBe(CO_A);
      }
      const other = await request(portal).post('/api/customer-portal/auth/login')
        .send({ email: 'zz.case.portal@example.com', password: PW, company_id: 999927 });
      expect(other.status).toBe(401);
    });

    it('a legacy mixed-case portal account (as all 5 live ones are) can sign in', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL session_replication_role = replica`);
        await client.query(`DELETE FROM customer_portal_users WHERE company_id = $1`, [CO_B]);
        await client.query(
          `INSERT INTO customer_portal_users (company_id, customer_name, email, password_hash)
           VALUES ($1, 'ZZ Legacy', 'ZZ.Case.PortalLegacy@Example.com', $2)`, [CO_B, await bcrypt.hash(PW, 4)]);
        await client.query('COMMIT');
      } finally { client.release(); }
      const res = await request(portal).post('/api/customer-portal/auth/login')
        .send({ email: 'ZZ.Case.PortalLegacy@Example.com', password: PW, company_id: CO_B });
      // Before the fix: 401 — the typed address was lowercased, the stored one was not.
      expect(res.status).toBe(200);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('company email stays separate', () => {
  it('normalising logins does not touch employees.company_email', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../shared/loginEmail.js'), 'utf8');
    expect(src).toMatch(/Company email \(employees\.company_email\) is NOT a login/);
  });

  it('no trigger normalises the employees table', async () => {
    const { rows } = await pool.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'employees'::regclass AND tgname LIKE '%normalize_email%'`);
    expect(rows).toEqual([]);
  });
});
