#!/usr/bin/env node
/**
 * Mint a valid JWT for an existing user — DEV/TEST ONLY.
 *
 * Looks the user up by email, resolves their primary scope + employee_id, and
 * signs a token with the app's JWT_SECRET (same payload shape as auth login).
 * Handy for smoke-testing authorization without knowing a user's password.
 *
 *   node scripts/mint-token.js employee@company.com
 *
 * Refuses to run when NODE_ENV=production.
 */
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pool from '../src/config/db.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to mint tokens in production.');
  process.exit(1);
}

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/mint-token.js <email>');
  process.exit(1);
}

const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('JWT_SECRET not set in env/.env'); process.exit(1); }

try {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.role, u.is_active,
            us.company_id, us.branch_id,
            (SELECT id FROM employees e WHERE e.company_email = u.email AND e.deleted_at IS NULL LIMIT 1) AS employee_id
       FROM users u
       LEFT JOIN user_scope us ON us.user_id = u.id AND us.is_primary = true
      WHERE u.email = $1
      LIMIT 1`,
    [email]
  );
  const u = rows[0];
  if (!u) { console.error(`No user with email ${email}`); process.exit(1); }
  if (!u.is_active) { console.error(`User ${email} is inactive`); process.exit(1); }

  const token = jwt.sign(
    {
      userId: u.id,
      email: u.email,
      role: u.role,
      company_id: u.company_id ?? null,
      branch_id: u.branch_id ?? null,
      employee_id: u.employee_id ?? null,
    },
    SECRET,
    { expiresIn: '1h' }
  );
  // Print ONLY the token on stdout so it can be captured directly.
  console.log(token);
} catch (e) {
  console.error('ERR', e.message);
  process.exit(1);
} finally {
  await pool.end().catch(() => {});
}
