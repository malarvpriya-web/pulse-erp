#!/usr/bin/env node
/**
 * seed-test-fixtures.mjs — Create the four fixture users the backend test
 * suite's token helper assumes (src/__tests__/helpers/tokens.js mints JWTs
 * for userId 1–4 with roles admin/hr/manager/employee; authorization is
 * DB-authoritative, so those rows must exist for real-DB tests to pass).
 *
 * CI runs this between `npm run migrate` and `npm test`. It is idempotent
 * (ON CONFLICT DO NOTHING) and safe on a dev DB, but it is a TEST fixture —
 * never run it against production. It refuses when NODE_ENV=production.
 *
 * Passwords are random per run: no test logs in with a password against the
 * real DB (login tests mock the pool), so no known value is needed.
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import pool   from '../src/config/db.js';

if (process.env.NODE_ENV === 'production') {
  console.error('❌  seed-test-fixtures is a test fixture — refusing to run in production.');
  process.exit(1);
}

const FIXTURES = [
  { id: 1, name: 'Test Admin',    email: 'admin@test.com',    role: 'admin'    },
  { id: 2, name: 'Test HR',       email: 'hr@test.com',       role: 'hr'       },
  { id: 3, name: 'Test Manager',  email: 'manager@test.com',  role: 'manager'  },
  { id: 4, name: 'Test Employee', email: 'employee@test.com', role: 'employee' },
];

const client = await pool.connect();
try {
  const hash = bcrypt.hashSync(crypto.randomBytes(24).toString('base64'), 10);

  await client.query('BEGIN');
  for (const f of FIXTURES) {
    await client.query(
      `INSERT INTO users (id, name, email, password_hash, role, is_active, company_id, must_change_password)
       VALUES ($1, $2, $3, $4, $5, true, 1, false)
       ON CONFLICT (id) DO NOTHING`,
      [f.id, f.name, f.email, hash, f.role]
    );
    await client.query(
      `INSERT INTO user_roles (user_id, role_id, company_id, is_primary)
       SELECT $1, r.id, 1, true FROM roles r WHERE r.code = $2
       ON CONFLICT DO NOTHING`,
      [f.id, f.role]
    );
    // Company scope: scope-guarded routes treat a user without a user_scope
    // row as global; the tenancy integration tests require company_id = 1.
    await client.query(
      `INSERT INTO user_scope (user_id, company_id, is_primary)
       SELECT $1, 1, true
        WHERE NOT EXISTS (SELECT 1 FROM user_scope WHERE user_id = $1 AND company_id = 1)`,
      [f.id]
    );
  }
  // Keep the sequence ahead of the explicit ids so later INSERTs don't collide
  await client.query(`SELECT setval('users_id_seq', GREATEST((SELECT MAX(id) FROM users), 100))`);
  await client.query('COMMIT');

  const { rows } = await client.query(
    `SELECT u.id, u.email, COALESCE(string_agg(r.code, ','), '—') AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r      ON r.id = ur.role_id
      WHERE u.id <= 4
      GROUP BY u.id, u.email ORDER BY u.id`
  );
  console.log('✅  Test fixtures present:');
  rows.forEach(r => console.log(`    ${r.id}  ${r.email}  [${r.roles}]`));
  process.exit(0);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('❌  seed-test-fixtures failed:', err.message);
  process.exit(1);
} finally {
  client.release();
}
