/**
 * Loading the talent routes must never drop talent_pool_members (DB-01, manual §244).
 *
 * A startup block dropped the table if candidate_id was a uuid, then recreated it
 * without the columns later migrations added. These tests run the real module in a
 * child process, because that is what a server start does, against scratch databases:
 *
 *   - the old block, replayed, loses every membership and those columns;
 *   - in that same state, loading the routes now changes nothing;
 *   - on the integer schema, rows and all columns are untouched;
 *   - with the table missing, it is still created, with its indexes and columns.
 *
 * Scratch databases only (helpers/migrationFixtureDb.js).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}
const { withFixtureDb } = await import('./helpers/migrationFixtureDb.js');

const BACKEND = resolve(here, '../..');
const ROUTES = resolve(here, '../modules/talent/talent.routes.js');

/** Import the real routes against this database, wait for its startup block, and record every statement. */
function loadRoutesAgainst(c) {
  const { host, port, database, password } = c;
  const script = `
    const { default: pool } = await import(${JSON.stringify(pathToFileURL(resolve(BACKEND, 'src/config/db.js')).href)});
    const real = pool.query.bind(pool);
    pool.query = (...a) => {
      if (typeof a[0] === 'string') console.log('SQL> ' + a[0].replace(/\\s+/g, ' ').trim().slice(0, 300));
      return real(...a);
    };
    const m = await import(${JSON.stringify(pathToFileURL(ROUTES).href)});
    await m.talentSchemaReady;
    process.exit(0);`;
  const env = { ...process.env, DB_HOST: host, DB_PORT: String(port), DB_NAME: database, DB_PASSWORD: password, DB_SSL: 'false', NODE_ENV: 'test' };
  delete env.DATABASE_URL;
  delete env.VITEST;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: BACKEND, env, encoding: 'utf8', timeout: 45000 });
  expect(out.status, out.stderr?.slice(0, 600)).toBe(0);
  return out.stdout.split(/\r?\n/).filter((l) => l.startsWith('SQL> ')).map((l) => l.slice(5));
}

const UUID_STATE = `
  CREATE TABLE talent_pool_members (
    pool_id integer NOT NULL, candidate_id uuid NOT NULL, added_at timestamptz DEFAULT now(),
    company_id integer, tags jsonb DEFAULT '[]', reason text, PRIMARY KEY (pool_id, candidate_id));
  INSERT INTO talent_pool_members (pool_id, candidate_id, company_id, reason) VALUES
    (1, '00000000-0000-4000-8000-000000000001', 1, 'kept'),
    (2, '00000000-0000-4000-8000-000000000002', 1, 'also kept');`;
const rows = async (c) => (await c.query(`SELECT to_jsonb(x) AS j FROM talent_pool_members x ORDER BY pool_id`)).rows.map((r) => r.j);
const columns = async (c) => (await c.query(
  `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'talent_pool_members' ORDER BY column_name`)).rows;
const hasColumn = async (c, name) => (await columns(c)).some((x) => x.column_name === name);
const typeOf = async (c, name) => (await columns(c)).find((x) => x.column_name === name)?.data_type;
const drops = (sql) => sql.filter((s) => /DROP\s+TABLE/i.test(s) && /talent_pool_members/i.test(s));

describe('talent_pool_members at startup', () => {
  it('the risk: the old block lost every membership and the later columns', async () => {
    await withFixtureDb('tlnddl', async ({ client: c }) => {
      await c.query(UUID_STATE);
      await c.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'talent_pool_members' AND column_name = 'candidate_id' AND data_type = 'uuid') THEN
            DROP TABLE IF EXISTS talent_pool_members CASCADE;
          END IF;
        END $$`);
      await c.query(`
        CREATE TABLE IF NOT EXISTS talent_pool_members (
          pool_id integer NOT NULL, candidate_id integer NOT NULL, added_at timestamptz DEFAULT now(), PRIMARY KEY (pool_id, candidate_id))`);
      expect(await rows(c)).toEqual([]);
      expect(await hasColumn(c, 'company_id')).toBe(false);
      expect(await hasColumn(c, 'tags')).toBe(false);
    });
  }, 60000);

  it('in the state that used to trigger the drop: nothing is dropped and every row survives', async () => {
    await withFixtureDb('tlnddl', async ({ client: c }) => {
      await c.query(UUID_STATE);
      const before = await rows(c);
      const sql = loadRoutesAgainst(c);
      expect(sql.length, 'the module issued no SQL at all, so this test proved nothing').toBeGreaterThan(0);
      expect(drops(sql)).toEqual([]);
      expect(await rows(c)).toEqual(before);
      expect(before).toHaveLength(2);
      expect(await typeOf(c, 'candidate_id')).toBe('uuid');
      expect(await hasColumn(c, 'company_id')).toBe(true);
    });
  }, 90000);

  it('on the integer schema: rows and every later column are untouched', async () => {
    await withFixtureDb('tlnddl', async ({ client: c }) => {
      await c.query(`
        CREATE TABLE employees (id serial PRIMARY KEY);
        CREATE TABLE talent_pool_members (
          pool_id integer NOT NULL, candidate_id integer NOT NULL, added_at timestamptz DEFAULT now(), notes text,
          added_by integer REFERENCES employees(id), company_id integer, added_by_user_id integer, tags jsonb DEFAULT '[]',
          reason text, source_stage varchar(50), PRIMARY KEY (pool_id, candidate_id));
        INSERT INTO talent_pool_members (pool_id, candidate_id, company_id, tags, reason, source_stage)
          VALUES (1, 10, 1, '["kept"]', 'kept', 'screening'), (2, 20, 1, '[]', 'also kept', 'applied');`);
      const before = { r: await rows(c), k: await columns(c) };
      const sql = loadRoutesAgainst(c);
      expect(drops(sql)).toEqual([]);
      expect({ r: await rows(c), k: await columns(c) }).toEqual(before);
    });
  }, 90000);

  it('with the table missing: it is created, with integer keys, its indexes and its columns', async () => {
    await withFixtureDb('tlnddl', async ({ client: c }) => {
      await c.query(`CREATE TABLE employees (id serial PRIMARY KEY)`);
      const sql = loadRoutesAgainst(c);
      expect(drops(sql)).toEqual([]);
      expect(sql.some((s) => s.startsWith('CREATE TABLE IF NOT EXISTS talent_pool_members '))).toBe(true);
      expect(await typeOf(c, 'pool_id')).toBe('integer');
      expect(await typeOf(c, 'candidate_id')).toBe('integer');
      expect(await hasColumn(c, 'notes')).toBe(true);
      expect(await hasColumn(c, 'added_by')).toBe(true);
      const { rows: idx } = await c.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'talent_pool_members' ORDER BY 1`);
      expect(idx.map((i) => i.indexname)).toEqual(expect.arrayContaining(['idx_tpm_pool', 'idx_tpm_candidate']));
      expect(await rows(c)).toEqual([]);
    });
  }, 90000);

  it('the source holds no such statement', () => {
    expect(readFileSync(ROUTES, 'utf8')).not.toMatch(/DROP\s+TABLE/i);
  });
});
