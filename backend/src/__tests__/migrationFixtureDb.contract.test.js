/**
 * The scratch-database helper's own safety contract (§226): it removes what it
 * created after success AND failure, refuses before creating anything when the
 * test-database environment cannot be proven, and sweeps a stale database only
 * when it is provably an abandoned fixture of a dead process on this host.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import crypto from 'node:crypto';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}
const { withFixtureDb, sweepStale, databaseExists } = await import('./helpers/migrationFixtureDb.js');
const { TEST_DB_PATTERN, MARKER } = await import('../../scripts/test-db/guard.mjs');
const { default: pool } = await import('../config/db.js');

const HOST_TAG = crypto.createHash('sha1').update(os.hostname()).digest('hex').slice(0, 4);
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;   // has exited by the time this returns

/** A raw maintenance connection, for planting databases the helper did not create. */
async function admin() {
  const o = pool.options;
  const conf = o.connectionString
    ? (() => { const u = new URL(o.connectionString); u.pathname = '/postgres'; return { connectionString: u.toString(), ssl: o.ssl }; })()
    : { host: o.host, port: o.port, user: o.user, password: o.password, ssl: o.ssl, database: 'postgres' };
  const c = new pg.Client(conf); await c.connect(); return c;
}
async function plant(name, { marker }) {
  const a = await admin();
  try { await a.query(`CREATE DATABASE "${name}" TEMPLATE template0`); } finally { await a.end(); }
  if (!marker) return;
  const o = pool.options;
  const conf = o.connectionString
    ? (() => { const u = new URL(o.connectionString); u.pathname = `/${name}`; return { connectionString: u.toString(), ssl: o.ssl }; })()
    : { host: o.host, port: o.port, user: o.user, password: o.password, ssl: o.ssl, database: name };
  const c = new pg.Client(conf); await c.connect();
  try {
    await c.query(`CREATE TABLE pulse_test_environment (id INTEGER PRIMARY KEY, marker TEXT, database_name TEXT)`);
    await c.query(`INSERT INTO pulse_test_environment VALUES (1, $1, $2)`, [MARKER, name]);
  } finally { await c.end(); }
}
async function dropPlanted(name) {
  const a = await admin();
  try { await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } finally { await a.end(); }
}
const staleName = (pid) => `pulse_e2e_migctrh${HOST_TAG}p${pid}t${Date.now().toString(36)}r${crypto.randomBytes(3).toString('hex')}`;

describe('migration fixture databases', () => {
  it('are named inside the test-database pattern, marked, and removed after success', async () => {
    let seen;
    await withFixtureDb('ctr', async ({ name, client }) => {
      seen = name;
      expect(name).toMatch(TEST_DB_PATTERN);
      expect((await client.query(`SELECT database_name FROM pulse_test_environment`)).rows[0].database_name).toBe(name);
      expect(await databaseExists(name)).toBe(true);
    });
    expect(await databaseExists(seen)).toBe(false);
  }, 60000);

  it('are removed after the test body throws', async () => {
    let seen;
    const err = await withFixtureDb('ctr', async ({ name }) => { seen = name; throw new Error('boom'); }).catch((e) => e);
    expect(err.message).toBe('boom');
    expect(await databaseExists(seen)).toBe(false);
  }, 60000);

  it('are removed after a migration fails and rolls back', async () => {
    let seen;
    const failing = { up: async (knex) => { await knex.raw(`CREATE TABLE t (id int)`); throw new Error('refused'); } };
    const err = await withFixtureDb('ctr', async ({ name, client, apply }) => {
      seen = name;
      const e = await apply(failing).catch((x) => x);
      expect(e.message).toBe('refused');
      expect((await client.query(`SELECT to_regclass('t') IS NULL AS gone`)).rows[0].gone).toBe(true);   // rolled back
      throw e;
    }).catch((e) => e);
    expect(err.message).toBe('refused');
    expect(await databaseExists(seen)).toBe(false);
  }, 60000);

  it('refuse before creating anything when PULSE_TEST_DB is not set', async () => {
    const before = (await pool.query(`SELECT COUNT(*)::int n FROM pg_database WHERE datname LIKE 'pulse_e2e_migctr%'`)).rows[0].n;
    const saved = process.env.PULSE_TEST_DB;
    delete process.env.PULSE_TEST_DB;
    try {
      const err = await withFixtureDb('ctr', async () => { throw new Error('must not run'); }).catch((e) => e);
      expect(err.name).toBe('NotATestDatabaseError');
    } finally { process.env.PULSE_TEST_DB = saved; }
    expect((await pool.query(`SELECT COUNT(*)::int n FROM pg_database WHERE datname LIKE 'pulse_e2e_migctr%'`)).rows[0].n).toBe(before);
  }, 60000);

  it('sweep a marked database left by a dead process, and nothing else', async () => {
    const pid = deadPid();
    const stale = staleName(pid);
    const unmarked = staleName(pid);
    await plant(stale, { marker: true });
    await plant(unmarked, { marker: false });
    try {
      await withFixtureDb('ctr', async ({ name: live }) => {
        // withFixtureDb swept on entry: the abandoned, marked fixture is gone...
        expect(await databaseExists(stale)).toBe(false);
        // ...and an explicit sweep now finds nothing more it may remove.
        expect(await sweepStale('ctr')).toEqual([]);
        expect(await databaseExists(unmarked)).toBe(true);      // no marker: not provably ours
        expect(await databaseExists(live)).toBe(true);          // this process is alive: untouched
      });
    } finally {
      await dropPlanted(stale);
      await dropPlanted(unmarked);
    }
  }, 60000);
});
