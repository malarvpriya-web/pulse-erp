/**
 * e2e-mint-token.mjs — issue a valid session token for the Playwright suite
 * WITHOUT a password.
 *
 * Why this exists: tests/auth.setup.ts used to drive the login form as
 * `superadmin@pulse.com` / `Pulse@123`. That account was deactivated on
 * 2026-07-08 in the canonical-login cleanup, so the form login now fails and
 * every e2e project — all of which depend on the `setup` project's storageState
 * — died at step 1. The suite was reporting green setups it never actually did.
 *
 * Rather than hard-code a new password (which drifts the same way, and means
 * committing a credential), this mints the exact token the login route would,
 * reusing the backend's OWN db pool and JWT_SECRET so it can never disagree with
 * the running server about the secret, the user, or their scope. It reads
 * nothing the server doesn't already trust.
 *
 * Prints a single line of JSON: { token, user, role, roles } — the shape
 * AuthContext persists to localStorage. auth.setup.ts consumes stdout.
 *
 * Env override: E2E_LOGIN_EMAIL selects the account (default the active
 * superadmin). The account MUST be is_active — an inactive one would mint a
 * token the server's verifyToken then rejects, reintroducing the original bug.
 */

// stdout carries the token JSON between ---E2E_AUTH_BEGIN/END--- sentinels.
// db.js calls dotenv.config(), whose v17 build prints an injection banner to
// STDOUT on every call — unsuppressable from here — so the caller extracts the
// fenced payload rather than parsing the whole stream. Pre-loading .env quietly
// still trims one of the two banners.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const jwt  = (await import('jsonwebtoken')).default;
const pool = (await import('../src/config/db.js')).default;

const EMAIL  = process.env.E2E_LOGIN_EMAIL || 'superadmin@manifest.in';
const SECRET = process.env.JWT_SECRET;

async function main() {
  if (!SECRET) throw new Error('JWT_SECRET is not set (checked backend/.env)');

  const { rows: [user] } = await pool.query(
    `SELECT id, email, role, employee_id, is_active
       FROM users WHERE email = $1`,
    [EMAIL]
  );
  if (!user)            throw new Error(`No user ${EMAIL}`);
  if (!user.is_active)  throw new Error(`User ${EMAIL} is inactive — pick an active account via E2E_LOGIN_EMAIL`);

  // Full role set from the junction (roles are many-to-many); fall back to the
  // primary mirror if the user predates the backfill.
  const { rows: rr } = await pool.query(
    `SELECT LOWER(r.code) AS code
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1`,
    [user.id]
  );
  const roles = rr.length ? rr.map(r => r.code) : [user.role].filter(Boolean);

  // Primary scope, matching what verifyToken re-reads per request.
  const { rows: sr } = await pool.query(
    `SELECT company_id, branch_id FROM user_scope
      WHERE user_id = $1 ORDER BY is_primary DESC NULLS LAST, id ASC LIMIT 1`,
    [user.id]
  );
  const scope = sr[0] || {};

  // Identical claim set to makeToken() in src/auth/auth.service.js.
  const token = jwt.sign(
    {
      userId:      user.id,
      email:       user.email,
      role:        user.role,
      roles,
      company_id:  scope.company_id ?? null,
      branch_id:   scope.branch_id  ?? null,
      employee_id: user.employee_id ?? null,
    },
    SECRET,
    { expiresIn: '12h' }
  );

  // `user` mirrors the login route's response object the frontend stores.
  // Fenced with a sentinel line: db.js's dotenv.config() prints an injection
  // banner to STDOUT that we cannot suppress from here, so the caller extracts
  // the payload between these markers rather than trusting the whole stream.
  process.stdout.write(
    '\n---E2E_AUTH_BEGIN---\n' +
    JSON.stringify({
      token,
      user: { id: user.id, email: user.email, role: user.role, roles, employee_id: user.employee_id },
      role: user.role,
      roles,
    }) +
    '\n---E2E_AUTH_END---\n'
  );
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    await pool.end().catch(() => {});
    process.stderr.write(String(err?.message || err) + '\n');
    process.exit(1);
  });
