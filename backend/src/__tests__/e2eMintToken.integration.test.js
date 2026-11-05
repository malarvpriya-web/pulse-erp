/**
 * scripts/e2e-mint-token.mjs finds the account whatever the casing.
 *
 * The Playwright `setup` project mints its session through this script. It
 * looked the account up with an exact `email = $1`, while the login route has
 * compared LOWER(BTRIM(email)) since migration 20261012000002 — and 243 stored
 * logins still hold mixed case. So E2E_LOGIN_EMAIL had to match the stored
 * spelling exactly, or every e2e project failed at step 1 with "No user …".
 *
 * Runs the REAL script as a child process (its stdout contract is what
 * auth.setup.ts parses) against a fixture login stored in mixed case, and
 * proves the script is read-only: the fixture row is byte-identical afterwards
 * and the script contains no write statement. No real account is used.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const jwt = (await import('jsonwebtoken')).default;
const run = promisify(execFile);

const SCRIPT = resolve(here, '../../scripts/e2e-mint-token.mjs');
const STORED = 'ZZ.Mint.Case@Example.COM';
let fixtureId;
let before;

const snapshot = async () => (await pool.query(
  `SELECT id, email, password_hash, role, is_active, employee_id, last_login, updated_at FROM users WHERE id = $1`,
  [fixtureId])).rows[0];

/** Run the script exactly as auth.setup.ts does and return its fenced payload. */
async function mint(email) {
  const { stdout } = await run('node', [SCRIPT], {
    cwd: resolve(here, '../..'),
    env: { ...process.env, E2E_LOGIN_EMAIL: email },
  });
  const m = stdout.match(/---E2E_AUTH_BEGIN---\n([\s\S]*?)\n---E2E_AUTH_END---/);
  if (!m) throw new Error(`no fenced payload in: ${stdout.slice(0, 200)}`);
  return JSON.parse(m[1]);
}

async function cleanup() {
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE LOWER(email) = 'zz.mint.case@example.com')`);
  await pool.query(`DELETE FROM users WHERE LOWER(email) = 'zz.mint.case@example.com'`);
}

beforeAll(async () => {
  await cleanup();
  // Stored mixed case, as a pre-migration writer left it: the normalising
  // trigger is bypassed for THIS session's transaction only.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL session_replication_role = replica`);
    fixtureId = (await client.query(
      `INSERT INTO users (name, email, password_hash, role, is_active)
       VALUES ('Zz Mint', $1, 'not-a-real-hash', 'employee', true) RETURNING id`, [STORED])).rows[0].id;
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  before = await snapshot();
});

afterAll(async () => { await cleanup(); });

describe('e2e-mint-token', () => {
  it.each(['zz.mint.case@example.com', 'ZZ.MINT.CASE@EXAMPLE.COM', '  Zz.Mint.Case@example.com  '])(
    'mints a token for the mixed-case account when asked for %j', async (typed) => {
      const out = await mint(typed);
      expect(out.user.id).toBe(fixtureId);
      expect(jwt.decode(out.token)).toMatchObject({ userId: fixtureId, email: STORED, role: 'employee' });
    }, 30_000);

  it('still refuses an address that does not exist', async () => {
    await expect(mint('zz.mint.nobody@example.com')).rejects.toThrow(/No user/);
  }, 30_000);

  it('modified nothing: the account row is byte-identical, password included', async () => {
    expect(await snapshot()).toEqual(before);
  });

  it('the script contains no write statement', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).not.toMatch(/\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b/i);
    expect(src).toMatch(/LOGIN_EMAIL_KEY/);
  });
});
