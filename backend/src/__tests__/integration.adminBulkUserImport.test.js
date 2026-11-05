/**
 * Admin bulk user import (POST /admin/users/bulk — the Setup Wizard's Users step)
 * gives every new account its own unrevealed initial password.
 *
 * It used to fall back to the SHARED default 'Welcome@123' and did not set
 * must_change_password (the column defaults to false), so every imported
 * account opened with a well-known password nobody was ever made to change.
 * It now uses shared/initialPassword.js — the same helper as employee logins.
 *
 * Proven here: the shared default cannot authenticate an imported account;
 * each account's initial secret is different and appears in no response or
 * audit row; must_change_password, roles and company are set; validation and
 * per-row failure reporting are unchanged; an existing account is untouched;
 * and the imported user can get in through "Forgot password?".
 *
 * Real database and real admin router. Authentication is the caller stub below
 * (server.js puts verifyToken at the /admin mount, not inside the router); the
 * reset e-mail is not actually sent. Fixtures live in test company 999937 and
 * are deleted by e-mail prefix and captured id.
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

vi.mock('../utils/mailer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sendPasswordResetOTP: vi.fn(async () => undefined),
}));

const { default: pool }        = await import('../config/db.js');
const { default: adminRoutes } = await import('../modules/admin/admin.routes.js');
const { requestPasswordReset, verifyResetOtp, resetPassword, loginUser } = await import('../auth/auth.service.js');
const { default: bcrypt }      = await import('bcryptjs');

// Real bcrypt and real queries against shared tables: under the 4-worker
// suite a test that takes 1s alone can blow vitest's 5s default.
vi.setConfig({ testTimeout: 20000 });

const COMPANY = 999937;
const SHARED_DEFAULTS = [...new Set(['Welcome@123', process.env.DEFAULT_EMPLOYEE_PASSWORD].filter(Boolean))];
const stamp = Date.now();
const PREFIX = `zz.bulk.${stamp}.`;
let seq = 0;
const nextEmail = () => `${PREFIX}${++seq}@example.com`;

// The caller, as verifyToken would have resolved it.
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
const as = (roles) => ({ 'x-test-user': JSON.stringify({ roles }) });
const ADMIN = as(['admin']);

/** POST a batch, capturing every plaintext bcrypt.hash saw while it ran. */
async function importUsers(users, headers = ADMIN) {
  const spy = vi.spyOn(bcrypt, 'hash');
  try {
    const res = await request(app).post('/api/admin/users/bulk').set(headers).send({ users });
    return { res, hashed: spy.mock.calls.map(c => c[0]) };
  } finally {
    spy.mockRestore();
  }
}

const userByEmail = async (email) =>
  (await pool.query(`SELECT * FROM users WHERE LOWER(BTRIM(email)) = LOWER(BTRIM($1))`, [email])).rows[0];

function expectNothingDisclosed(res, secrets) {
  const text = JSON.stringify(res.body ?? {});
  for (const s of [...secrets, ...SHARED_DEFAULTS]) expect(text).not.toContain(s);
  expect(text).not.toMatch(/"(password|password_hash|temp_password|otp)"\s*:/i);
}

const createdIds = [];
// Database clock at suite start: audit rows from this run are newer than this.
let since;

beforeAll(async () => {
  ({ rows: [{ t: since }] } = await pool.query(`SELECT LOCALTIMESTAMP - INTERVAL '1 minute' AS t`));
  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1, 'ZZBULK Import Fixture', 'ZZBULK')
     ON CONFLICT (id) DO NOTHING`, [COMPANY]);
});

afterAll(async () => {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE LOWER(email) LIKE $1 OR id = ANY($2::int[])`, [`${PREFIX}%`, createdIds]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  await pool.query('DELETE FROM password_reset_otps WHERE user_id = ANY($1::int[])', [ids]);
  await pool.query('DELETE FROM user_roles WHERE user_id = ANY($1::int[])', [ids]);
  await pool.query('DELETE FROM user_scope WHERE user_id = ANY($1::int[])', [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
});

// ── New accounts ──────────────────────────────────────────────────────────────
describe('newly imported accounts', () => {
  let res, hashed, emails;
  beforeAll(async () => {
    emails = [nextEmail(), nextEmail(), nextEmail()];
    ({ res, hashed } = await importUsers(emails.map((email, i) => ({ name: `ZZBULK User ${i}`, email }))));
  });

  it('are created, reported per row as before', () => {
    expect(res.status).toBe(201);
    expect(res.body.created.map(u => u.email)).toEqual(emails);
    expect(res.body.failed).toEqual([]);
    expect(Object.keys(res.body.created[0]).sort()).toEqual(['department', 'email', 'id', 'name', 'role']);
  });

  it('each get a different 32-byte random initial secret', () => {
    expect(hashed).toHaveLength(3);
    for (const s of hashed) expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(hashed).size).toBe(3);
    for (const s of hashed) expect(SHARED_DEFAULTS).not.toContain(s);
  });

  it('the shared default cannot authenticate any of them', async () => {
    for (const email of emails) {
      const u = await userByEmail(email);
      for (const d of SHARED_DEFAULTS) expect(await bcrypt.compare(d, u.password_hash)).toBe(false);
      await expect(loginUser(email, SHARED_DEFAULTS[0])).rejects.toThrow();
    }
  });

  it('each stored hash matches only its own secret', async () => {
    const users = await Promise.all(emails.map(userByEmail));
    const matches = await Promise.all(users.map(async u =>
      (await Promise.all(hashed.map(s => bcrypt.compare(s, u.password_hash)))).filter(Boolean).length));
    expect(matches).toEqual([1, 1, 1]);
  });

  it('never discloses a credential — not in the response, the stored row, or the audit trail', async () => {
    expectNothingDisclosed(res, hashed);
    const needles = hashed.map(s => `%${s}%`);
    const { rows: [{ n: stored }] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM users
        WHERE LOWER(email) LIKE $1 AND to_jsonb(users)::text LIKE ANY($2::text[])`, [`${PREFIX}%`, needles]);
    expect(stored).toBe(0);
    // Only rows written during this run can contain a secret minted by it.
    const { rows: [{ n: audited }] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs
        WHERE created_at >= $1
          AND (new_data_json::text LIKE ANY($2::text[]) OR old_data_json::text LIKE ANY($2::text[]))`,
      [since, needles]);
    expect(audited).toBe(0);
    // Not vacuous: the window does contain this import's own audit entry.
    const { rows: [{ n: ours }] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE created_at >= $1 AND action_type = 'bulk_create'`, [since]);
    expect(ours).toBeGreaterThan(0);
  });

  it('are forced to change the password, active, in the caller\'s company, with the employee role', async () => {
    for (const email of emails) {
      const u = await userByEmail(email);
      expect(u).toMatchObject({ must_change_password: true, is_active: true, company_id: COMPANY, role: 'employee' });
      const { rows } = await pool.query(
        `SELECT LOWER(r.code) AS code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [u.id]);
      expect(rows.map(r => r.code)).toContain('employee');
    }
  });

  it('can set a password and sign in through "Forgot password?"', async () => {
    const email = emails[0];
    expect((await requestPasswordReset(email)).sent).toBe(true);
    const u = await userByEmail(email);
    const { rows: [otp] } = await pool.query(
      `SELECT otp FROM password_reset_otps WHERE user_id = $1 AND used = false ORDER BY id DESC LIMIT 1`, [u.id]);
    await verifyResetOtp(email, otp.otp);
    await resetPassword(email, otp.otp, 'ZzBulk-Chosen-Pass-1!');
    const session = await loginUser(email, 'ZzBulk-Chosen-Pass-1!');
    expect(session.user?.email ?? session.email).toBe(email);
    expect((await userByEmail(email)).must_change_password).toBe(false);
  });
});

// ── Roles and validation, unchanged ───────────────────────────────────────────
describe('roles and validation are preserved', () => {
  it('a row\'s role is granted', async () => {
    const email = nextEmail();
    const { res } = await importUsers([{ name: 'ZZBULK HR', email, role: 'hr', department: 'HR' }]);
    expect(res.status).toBe(201);
    const u = await userByEmail(email);
    expect(u).toMatchObject({ role: 'hr', department: 'HR', must_change_password: true });
    const { rows } = await pool.query(
      `SELECT LOWER(r.code) AS code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [u.id]);
    expect(rows.map(r => r.code)).toContain('hr');
  });

  it('per-row failures are reported and do not abort the batch', async () => {
    const good = nextEmail();
    const { res } = await importUsers([
      { name: '', email: nextEmail() },                                   // missing name
      { name: 'ZZBULK Super', email: nextEmail(), role: 'super_admin' },  // admin may not grant super_admin
      { name: 'ZZBULK Fine', email: good },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.created.map(u => u.email)).toEqual([good]);
    expect(res.body.failed.map(f => f.error)).toEqual([
      'name and email are required',
      'Only a super_admin can assign the super_admin role',
    ]);
  });

  it('a supplied password is refused per row and creates no account', async () => {
    const email = nextEmail();
    const { res, hashed } = await importUsers([{ name: 'ZZBULK Pw', email, password: 'Chosen-By-Script-1' }]);
    expect(res.status).toBe(400);
    expect(res.body.failed[0].error).toMatch(/password is not accepted/);
    expect(hashed).toEqual([]);
    expect(await userByEmail(email)).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('Chosen-By-Script-1');
  });

  it('only admins may import (allowRoles unchanged)', async () => {
    const { res } = await importUsers([{ name: 'ZZBULK X', email: nextEmail() }], as(['hr']));
    expect(res.status).toBe(403);
  });
});

// ── Existing accounts ─────────────────────────────────────────────────────────
describe('an address that already has an account', () => {
  it('is reported as existing and the account is left exactly as it was', async () => {
    const email = nextEmail();
    const ownHash = await bcrypt.hash('ZzBulk-Existing-Own-1', 10);
    const { rows: [existing] } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, is_active, company_id, must_change_password)
       VALUES ('ZZBULK Existing', $1, $2, 'manager', true, $3, false) RETURNING id`, [email, ownHash, COMPANY]);
    createdIds.push(existing.id);
    const snapshot = async () => ({
      user:  (await pool.query('SELECT * FROM users WHERE id = $1', [existing.id])).rows[0],
      roles: (await pool.query('SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id', [existing.id])).rows,
    });
    const before = await snapshot();

    // Same address in a different case: still the same login.
    const { res } = await importUsers([{ name: 'ZZBULK Dup', email: email.toUpperCase(), role: 'employee' }]);
    expect(res.status).toBe(400);
    expect(res.body.failed).toEqual([{ email: email.toUpperCase(), error: 'Email already exists' }]);
    expect(await snapshot()).toEqual(before);
    expect(await bcrypt.compare('ZzBulk-Existing-Own-1', before.user.password_hash)).toBe(true);
    const { rows } = await pool.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [email]);
    expect(rows).toHaveLength(1);
  });
});

// ── The source ────────────────────────────────────────────────────────────────
describe('the import route', () => {
  const src = readFileSync(resolve(here, '../modules/admin/admin.routes.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('no longer carries a shared default password', () => {
    expect(src).not.toMatch(/Welcome@123/);
  });

  it('uses the shared helper rather than its own generator', () => {
    expect(src).toMatch(/import \{ unrevealedInitialPasswordHash \} from '\.\.\/\.\.\/shared\/initialPassword\.js'/);
    expect(src).not.toMatch(/randomBytes|Math\.random/);
  });
});
