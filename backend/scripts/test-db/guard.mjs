/**
 * scripts/test-db/guard.mjs — the ONE test-database check every writing test
 * tool runs before it touches anything (§220). It FAILS CLOSED.
 *
 * A database is a recognised isolated test database only if ALL hold:
 *   1. PULSE_TEST_DB=1 is set explicitly in the environment;
 *   2. current_database() matches TEST_DB_PATTERN (pulse_e2e, pulse_e2e_<x>);
 *   3. it is not the developer database named in backend/.env (read from the
 *      FILE, so an env override cannot disguise it);
 *   4. it holds the marker row written by scripts/test-db/setup.mjs, and the
 *      marker names THIS database (a dump of the test DB restored somewhere
 *      else carries a marker that names the wrong database and is refused).
 * There is no fallback: anything else exits non-zero before a single write.
 *
 * assertTestServer() additionally proves that the HTTP server a tool is about
 * to call is serving THIS database: it plants a one-off vendor in the test
 * company, reads it back over the API, and removes it. A server on the live
 * database cannot return it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TEST_DB_PATTERN = /^pulse_e2e(_[a-z0-9]+)?$/;
export const MARKER = 'pulse-isolated-test-database';
export const TEST_COMPANY_CODE = 'E2ETEST';

export class NotATestDatabaseError extends Error {
  constructor(tool, why) {
    super(`[${tool}] refusing to run: ${why}. This tool writes numbered documents and may only run against an isolated test database — see backend/scripts/test-db/README.md.`);
    this.name = 'NotATestDatabaseError';
  }
}

/** DB_NAME as written in backend/.env — the developer database. */
export function devDatabaseName() {
  try {
    const env = fs.readFileSync(path.resolve(__dirname, '../../.env'), 'utf8');
    return env.match(/^DB_NAME=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') || null;
  } catch { return null; }
}

export async function assertTestDatabase(pool, tool) {
  if (process.env.PULSE_TEST_DB !== '1') throw new NotATestDatabaseError(tool, 'PULSE_TEST_DB=1 is not set');
  let db;
  try {
    ({ rows: [{ db }] } = await pool.query('SELECT current_database() AS db'));
  } catch (e) {
    throw new NotATestDatabaseError(tool, `cannot reach the database (${e.message})`);
  }
  if (!TEST_DB_PATTERN.test(db)) throw new NotATestDatabaseError(tool, `connected to "${db}", which is not a test database name (${TEST_DB_PATTERN})`);
  const dev = devDatabaseName();
  if (dev && dev.toLowerCase() === db.toLowerCase()) throw new NotATestDatabaseError(tool, `connected to the developer database "${db}"`);
  let marker;
  try {
    ({ rows: [marker] } = await pool.query(`SELECT marker, database_name FROM pulse_test_environment WHERE id = 1`));
  } catch {
    throw new NotATestDatabaseError(tool, `"${db}" has no pulse_test_environment marker (run scripts/test-db/setup.mjs)`);
  }
  if (!marker || marker.marker !== MARKER) throw new NotATestDatabaseError(tool, `"${db}" carries no valid test marker`);
  if (marker.database_name !== db) throw new NotATestDatabaseError(tool, `"${db}" carries a marker for "${marker.database_name}" — a copied test database is not recognised`);
  return db;
}

/** The test company every guarded tool works in (created by setup.mjs). */
export async function testCompanyId(pool) {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = $1`, [TEST_COMPANY_CODE]);
  if (!rows[0]) throw new Error(`test company ${TEST_COMPANY_CODE} is missing — re-run scripts/test-db/setup.mjs`);
  return rows[0].id;
}

/**
 * Prove the server at `apiBase` serves this test database, using `token`
 * (a JWT for a user of the test company). Throws when it does not.
 */
export async function assertTestServer(pool, apiBase, token, tool) {
  if (!apiBase || /:5000(\/|$)/.test(apiBase)) throw new NotATestDatabaseError(tool, `API base "${apiBase}" is the developer server port`);
  const company = await testCompanyId(pool);
  const nonce = `ZZE2E-SERVER-CHECK-${crypto.randomBytes(6).toString('hex')}`;
  const { rows: [v] } = await pool.query(`INSERT INTO vendors (vendor_name, company_id) VALUES ($1, $2) RETURNING id`, [nonce, company]);
  try {
    const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/procurement/vendors`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    if (!res.ok || !text.includes(nonce)) {
      throw new NotATestDatabaseError(tool, `the server at ${apiBase} does not serve this test database (status ${res.status}; check vendor not visible)`);
    }
  } finally {
    await pool.query(`DELETE FROM vendors WHERE id = $1`, [v.id]);
  }
}

/**
 * The JWT signing secret of the TEST backend. Deliberately different from the
 * developer .env JWT_SECRET: a token minted for a test-database user is then
 * rejected (401) by the developer server, so a tool pointed at the wrong
 * server cannot act as anyone there — and assertTestServer fails closed.
 * Override with PULSE_TEST_JWT_SECRET; never set it to the real secret.
 */
export function testJwtSecret() {
  const s = process.env.PULSE_TEST_JWT_SECRET || 'pulse-e2e-test-database-only-signing-key-0001';
  if (s.length < 32) throw new Error('PULSE_TEST_JWT_SECRET must be at least 32 characters');
  try {
    const env = fs.readFileSync(path.resolve(__dirname, '../../.env'), 'utf8');
    const dev = env.match(/^JWT_SECRET=(.*)$/m)?.[1]?.trim();
    if (dev && dev === s) throw new Error('the test JWT secret must differ from the developer JWT_SECRET');
  } catch (e) { if (/must differ/.test(e.message)) throw e; }
  return s;
}

/** A token for the E2ETEST super admin, signed with the TEST secret. */
export async function mintTestToken(pool, email = 'e2e.superadmin@pulse-e2e.test') {
  const { default: jwt } = await import('jsonwebtoken');
  const { rows: [u] } = await pool.query(
    `SELECT u.id, u.email, u.employee_id, u.company_id,
            COALESCE(ARRAY_AGG(r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
       FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
      WHERE LOWER(u.email) = LOWER($1) AND u.is_active GROUP BY u.id`, [email]);
  if (!u) throw new Error(`no active test user ${email}`);
  return jwt.sign({ userId: u.id, email: u.email, employee_id: u.employee_id, company_id: u.company_id,
                    roles: u.roles, role: u.roles[0] || 'user' }, testJwtSecret(), { expiresIn: '2h' });
}

/** For scripts: run the DB check, print the reason and exit 1 on refusal. */
export async function guardOrExit(pool, tool) {
  try {
    return await assertTestDatabase(pool, tool);
  } catch (e) {
    console.error(`\n❌ ${e.message}\n`);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}
