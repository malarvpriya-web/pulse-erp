#!/usr/bin/env node
/**
 * scripts/test-db/setup.mjs — create (or refresh) the isolated test database.
 * §220. See README.md in this folder.
 *
 *   node scripts/test-db/setup.mjs [pulse_e2e]
 *
 * 1. Refuses any name outside TEST_DB_PATTERN and the developer DB in .env.
 * 2. Creates the database if it does not exist. If it EXISTS without this
 *    tool's marker it is somebody else's database: refused, untouched.
 * 3. Builds the schema with the normal runner (`npm run migrate` → baseline.sql
 *    bootstrap on an empty DB, then every migration), with DATABASE_URL
 *    REMOVED from the child's environment so it can only reach DB_NAME.
 * 4. Writes the marker row (pulse_test_environment) naming this database.
 * 5. Seeds, through the guard: the CI fixture users (seed-test-fixtures.mjs)
 *    and the E2ETEST company with a super-admin login, a warehouse, an item and
 *    a rated vendor — what the guarded browser spec and probes need.
 * Idempotent: re-running refreshes migrations and the seed.
 *
 * The developer database, its rows and its sequences are never connected to by
 * anything this script runs (each child gets DB_NAME=<test db> explicitly).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import pg from 'pg';
import { TEST_DB_PATTERN, MARKER, TEST_COMPANY_CODE, devDatabaseName } from './guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(BACKEND, '.env'), quiet: true });

const name = process.argv[2] || 'pulse_e2e';
const die = (m) => { console.error(`\n❌ ${m}\n`); process.exit(1); };
if (!TEST_DB_PATTERN.test(name)) die(`"${name}" is not an allowed test database name (${TEST_DB_PATTERN}).`);
const dev = devDatabaseName();
if (dev && dev.toLowerCase() === name.toLowerCase()) die(`"${name}" is the developer database.`);

const conn = (database) => ({
  host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database,
});

// ── 1-2. create, or confirm it is ours ──────────────────────────────────────
const admin = new pg.Client(conn('postgres'));
await admin.connect();
const { rows: exists } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name]);
let created = false;
if (!exists.length) {
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  console.log(`✅ created database ${name}`);
}
await admin.end();

const probe = new pg.Client(conn(name));
await probe.connect();
if (!created) {
  const ok = await probe.query(`SELECT marker, database_name FROM pulse_test_environment WHERE id = 1`)
    .then(r => r.rows[0]?.marker === MARKER && r.rows[0]?.database_name === name).catch(() => false);
  if (!ok) { await probe.end(); die(`database "${name}" exists but was not created by this tool (no marker) — refusing to touch it.`); }
  console.log(`ℹ️  ${name} exists and carries the test marker — refreshing`);
}
await probe.end();

// ── 3. schema via the normal runner, pointed ONLY at the test DB ─────────────
const childEnv = { ...process.env, DB_NAME: name, PULSE_TEST_DB: '1' };
delete childEnv.DATABASE_URL;
const run = (args, label) => {
  const r = spawnSync(process.execPath, args, { cwd: BACKEND, env: childEnv, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) die(`${label} failed (exit ${r.status}):\n${out.slice(-3000)}`);
  return out;
};
const mig = run(['-e', "import('./src/config/migrations.js').then(m=>m.runMigrations()).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})"], 'migrations');
console.log(mig.split('\n').filter(l => /✅|❌|Applied|baseline|fresh/i.test(l)).slice(-6).join('\n'));

// ── 4. marker ────────────────────────────────────────────────────────────────
const db = new pg.Client(conn(name));
await db.connect();
await db.query(`
  CREATE TABLE IF NOT EXISTS pulse_test_environment (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    marker        TEXT NOT NULL,
    database_name TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
await db.query(`INSERT INTO pulse_test_environment (id, marker, database_name) VALUES (1, $1, $2)
                ON CONFLICT (id) DO UPDATE SET marker = EXCLUDED.marker, database_name = EXCLUDED.database_name`, [MARKER, name]);
await db.end();

// ── 5. seed, through the guard ───────────────────────────────────────────────
run(['scripts/seed-test-fixtures.mjs'], 'seed-test-fixtures');
run(['scripts/test-db/seed.mjs'], 'test seed');
console.log(`✅ ${name} ready — marker written, schema current, ${TEST_COMPANY_CODE} seeded.`);
