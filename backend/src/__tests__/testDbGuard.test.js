/**
 * testDbGuard.test.js — §220: every branch of the test-database guard fails
 * closed. Pure: fake pools, no database. Plus the setup script's refusal of
 * non-test names (spawned; it exits before connecting anywhere).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertTestDatabase, assertTestServer, NotATestDatabaseError, MARKER, TEST_DB_PATTERN, devDatabaseName, testJwtSecret,
} from '../../scripts/test-db/guard.mjs';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A pool that answers current_database() and the marker query. */
function fakePool(db, marker = { marker: MARKER, database_name: db }, { markerTableMissing = false } = {}) {
  return {
    query: async (sql) => {
      if (/current_database/.test(sql)) return { rows: [{ db }] };
      if (/pulse_test_environment/.test(sql)) {
        if (markerTableMissing) throw new Error('relation "pulse_test_environment" does not exist');
        return { rows: marker ? [marker] : [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const saved = process.env.PULSE_TEST_DB;
afterEach(() => { if (saved === undefined) delete process.env.PULSE_TEST_DB; else process.env.PULSE_TEST_DB = saved; });

describe('assertTestDatabase', () => {
  it('refuses without PULSE_TEST_DB=1', async () => {
    delete process.env.PULSE_TEST_DB;
    await expect(assertTestDatabase(fakePool('pulse_e2e'), 't')).rejects.toThrow(/PULSE_TEST_DB=1 is not set/);
  });

  it.each(['Pulse', 'pulse', 'pulse_ci_test', 'postgres', 'pulse_e2e-live', 'my_pulse_e2e'])(
    'refuses a database named %j', async (name) => {
      process.env.PULSE_TEST_DB = '1';
      await expect(assertTestDatabase(fakePool(name), 't')).rejects.toBeInstanceOf(NotATestDatabaseError);
    });

  it('refuses the developer database even if it were named like a test DB', async () => {
    process.env.PULSE_TEST_DB = '1';
    const dev = devDatabaseName();
    expect(dev).toBeTruthy();
    await expect(assertTestDatabase(fakePool(dev), 't')).rejects.toBeInstanceOf(NotATestDatabaseError);
  });

  it('refuses a test-named database with no marker table', async () => {
    process.env.PULSE_TEST_DB = '1';
    await expect(assertTestDatabase(fakePool('pulse_e2e', null, { markerTableMissing: true }), 't')).rejects.toThrow(/no pulse_test_environment marker/);
  });

  it('refuses a wrong or empty marker', async () => {
    process.env.PULSE_TEST_DB = '1';
    await expect(assertTestDatabase(fakePool('pulse_e2e', null), 't')).rejects.toThrow(/no valid test marker/);
    await expect(assertTestDatabase(fakePool('pulse_e2e', { marker: 'nope', database_name: 'pulse_e2e' }), 't')).rejects.toThrow(/no valid test marker/);
  });

  it('refuses a COPIED marker that names another database', async () => {
    process.env.PULSE_TEST_DB = '1';
    await expect(assertTestDatabase(fakePool('pulse_e2e_copy', { marker: MARKER, database_name: 'pulse_e2e' }), 't'))
      .rejects.toThrow(/copied test database is not recognised/);
  });

  it('accepts a marked test database', async () => {
    process.env.PULSE_TEST_DB = '1';
    await expect(assertTestDatabase(fakePool('pulse_e2e'), 't')).resolves.toBe('pulse_e2e');
    await expect(assertTestDatabase(fakePool('pulse_e2e_ci'), 't')).resolves.toBe('pulse_e2e_ci');
  });

  it('the allowlist is narrow', () => {
    expect(TEST_DB_PATTERN.test('pulse_e2e')).toBe(true);
    expect(TEST_DB_PATTERN.test('Pulse')).toBe(false);
    expect(TEST_DB_PATTERN.test('pulse_e2e_Live')).toBe(false);
  });
});

describe('assertTestServer', () => {
  it('refuses the developer server port before any request', async () => {
    const pool = { query: async () => { throw new Error('must not query'); } };
    await expect(assertTestServer(pool, 'http://localhost:5000', 'tok', 't')).rejects.toThrow(/developer server port/);
    await expect(assertTestServer(pool, '', 'tok', 't')).rejects.toBeInstanceOf(NotATestDatabaseError);
  });
});

describe('test JWT secret', () => {
  it('differs from the developer JWT_SECRET', () => {
    const s = testJwtSecret();
    expect(s.length).toBeGreaterThanOrEqual(32);
    const env = fs.readFileSync(path.join(BACKEND, '.env'), 'utf8');
    expect(env.match(/^JWT_SECRET=(.*)$/m)?.[1]?.trim()).not.toBe(s);
  });
});

describe('setup.mjs refuses non-test names before connecting', () => {
  it.each(['Pulse', 'pulse_ci_test', 'postgres'])('refuses %j', (name) => {
    const r = spawnSync(process.execPath, ['scripts/test-db/setup.mjs', name], { cwd: BACKEND, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/not an allowed test database name|is the developer database/);
  });
});
