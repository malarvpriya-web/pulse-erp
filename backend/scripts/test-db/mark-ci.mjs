#!/usr/bin/env node
/**
 * scripts/test-db/mark-ci.mjs — write the test-database marker in CI (§221).
 *
 *   node scripts/test-db/mark-ci.mjs pulse_e2e_ci
 *
 * Locally the marker is written by setup.mjs, which also CREATES the database.
 * In CI the database is created by the Postgres service container, so this
 * step only marks it, and refuses unless ALL hold:
 *   - running in CI (CI=true, set by GitHub Actions);
 *   - the name given on the command line matches TEST_DB_PATTERN;
 *   - the database the connection actually reaches (current_database(), via
 *     src/config/db.js — DATABASE_URL in CI) IS that name;
 *   - the server is on localhost (the job's own service container).
 * The marker then names that exact database, and the suite's globalSetup
 * verifies it before any test runs.
 */
import { TEST_DB_PATTERN, MARKER } from './guard.mjs';

const name = process.argv[2];
const die = (m) => { console.error(`\n❌ mark-ci: ${m}\n`); process.exit(1); };
if (process.env.CI !== 'true') die('only runs in CI (CI=true); locally use scripts/test-db/setup.mjs');
if (!name || !TEST_DB_PATTERN.test(name)) die(`"${name}" is not an allowed test database name (${TEST_DB_PATTERN})`);

const { default: pool } = await import('../../src/config/db.js');
try {
  const { rows: [r] } = await pool.query(`SELECT current_database() AS db, COALESCE(inet_server_addr()::text, 'local socket') AS addr`);
  if (r.db !== name) die(`connected to "${r.db}", not "${name}"`);
  if (!/^(127\.0\.0\.1|::1|local socket)/.test(r.addr)) die(`database server ${r.addr} is not the job's local service container`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pulse_test_environment (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      marker        TEXT NOT NULL,
      database_name TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`INSERT INTO pulse_test_environment (id, marker, database_name) VALUES (1, $1, $2)
                    ON CONFLICT (id) DO UPDATE SET marker = EXCLUDED.marker, database_name = EXCLUDED.database_name`, [MARKER, name]);
  console.log(`✅ marked ${name} as the isolated CI test database`);
} finally {
  await pool.end().catch(() => {});
}
