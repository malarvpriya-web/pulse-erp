/**
 * Loading the sales routes must never drop sales_events, competitors or
 * sales_settings, or replace subscriptions.company_id (DB-01, manual §242, §243).
 *
 * Each table had a startup block: if company_id was a uuid, drop the table and
 * recreate it empty. These tests run the real module in a child process, because
 * that is what a server start does, against scratch databases:
 *
 *   - in the exact state that used to trigger the drop, rows and columns survive
 *     and no drop is attempted;
 *   - on a database without the tables, they are still created;
 *   - on the current integer schema, rows are untouched.
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
const ROUTES = resolve(here, '../modules/sales/routes/sales.routes.js');
const TABLES = ['sales_events', 'competitors', 'sales_settings'];
const SETTLE_MS = 5000;

/** Import the real routes against this database, recording every statement the pool receives. */
function loadRoutesAgainst(c) {
  const { host, port, database, password } = c;
  const script = `
    const { default: pool } = await import(${JSON.stringify(pathToFileURL(resolve(BACKEND, 'src/config/db.js')).href)});
    const real = pool.query.bind(pool);
    pool.query = (...a) => {
      if (typeof a[0] === 'string') console.log('SQL> ' + a[0].replace(/\\s+/g, ' ').trim().slice(0, 200));
      return real(...a);
    };
    await import(${JSON.stringify(pathToFileURL(ROUTES).href)});
    await new Promise((r) => setTimeout(r, ${SETTLE_MS}));
    process.exit(0);`;
  const env = { ...process.env, DB_HOST: host, DB_PORT: String(port), DB_NAME: database, DB_PASSWORD: password, DB_SSL: 'false', NODE_ENV: 'test' };
  delete env.DATABASE_URL;
  delete env.VITEST;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: BACKEND, env, encoding: 'utf8', timeout: 45000 });
  expect(out.status, out.stderr?.slice(0, 600)).toBe(0);
  return out.stdout.split(/\r?\n/).filter((l) => l.startsWith('SQL> ')).map((l) => l.slice(5));
}

const legacyShape = async (c) => {
  await c.query(`
    CREATE TABLE sales_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, title varchar(255) NOT NULL);
    CREATE TABLE competitors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, name varchar(255) NOT NULL);
    CREATE TABLE sales_settings (id serial PRIMARY KEY, company_id uuid, default_currency varchar(10) DEFAULT 'INR');
    INSERT INTO sales_events (company_id, title) VALUES (gen_random_uuid(), 'kept event');
    INSERT INTO competitors (company_id, name) VALUES (gen_random_uuid(), 'kept competitor');
    INSERT INTO sales_settings (company_id) VALUES (gen_random_uuid());`);
};
const rowsOf = async (c) => {
  const out = {};
  for (const t of TABLES) out[t] = (await c.query(`SELECT to_jsonb(x) AS j FROM ${t} x ORDER BY 1`)).rows.map((r) => r.j);
  return out;
};
const companyType = async (c, t) => (await c.query(
  `SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = 'company_id'`, [t])).rows[0]?.data_type;
const SUBS_UUID = `
  CREATE TABLE subscriptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, plan_name varchar(255) NOT NULL,
    amount numeric(14,2) NOT NULL, start_date date NOT NULL);
  INSERT INTO subscriptions (company_id, plan_name, amount, start_date)
    VALUES ('00000000-0000-4000-8000-000000000001', 'kept plan', 100, '2026-01-01'),
           ('00000000-0000-4000-8000-000000000002', 'other tenant plan', 200, '2026-01-01');`;
const subscriptionRows = async (c) => (await c.query(`SELECT id, company_id, plan_name FROM subscriptions ORDER BY plan_name`)).rows;
const DROPS = (sql) => sql.filter((s) => /DROP\s+TABLE/i.test(s) && new RegExp(TABLES.join('|'), 'i').test(s));

describe('subscriptions.company_id', () => {
  it('the risk: the old repair block kept the rows but erased which company owned them', async () => {
    await withFixtureDb('slsddl', async ({ client: c }) => {
      await c.query(SUBS_UUID);
      await c.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='subscriptions' AND column_name='company_id' AND udt_name='uuid') THEN
            ALTER TABLE subscriptions DROP COLUMN company_id;
            ALTER TABLE subscriptions ADD COLUMN company_id INTEGER;
          END IF;
        END $$`);
      const rows = await subscriptionRows(c);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.company_id)).toEqual([null, null]);
      // Every company-scoped read now finds nothing, and nothing reports an error.
      expect((await c.query(`SELECT COUNT(*)::int AS n FROM subscriptions WHERE company_id = $1`, [1])).rows[0].n).toBe(0);
    });
  }, 60000);

  it('loading the routes leaves a uuid column and its owners exactly as they are', async () => {
    await withFixtureDb('slsddl', async ({ client: c }) => {
      await c.query(SUBS_UUID);
      const before = await subscriptionRows(c);
      const sql = loadRoutesAgainst(c);
      expect(sql.some((s) => /DROP\s+COLUMN/i.test(s)), 'a DROP COLUMN was sent').toBe(false);
      expect(await subscriptionRows(c)).toEqual(before);
      expect(await companyType(c, 'subscriptions')).toBe('uuid');
    });
  }, 90000);

  it('on the integer schema: owners are untouched', async () => {
    await withFixtureDb('slsddl', async ({ client: c }) => {
      await c.query(`
        CREATE TABLE subscriptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id integer, plan_name varchar(255) NOT NULL,
          amount numeric(14,2) NOT NULL, start_date date NOT NULL);
        INSERT INTO subscriptions (company_id, plan_name, amount, start_date) VALUES (7, 'kept', 100, '2026-01-01');`);
      const before = await subscriptionRows(c);
      loadRoutesAgainst(c);
      expect(await subscriptionRows(c)).toEqual(before);
      expect(before[0].company_id).toBe(7);
    });
  }, 90000);

  it('on a database without the table: it is still created, with an integer column', async () => {
    await withFixtureDb('slsddl', async ({ client: c }) => {
      const sql = loadRoutesAgainst(c);
      expect(sql.some((s) => s.startsWith('CREATE TABLE IF NOT EXISTS subscriptions '))).toBe(true);
      expect(await companyType(c, 'subscriptions')).toBe('integer');
    });
  }, 90000);
});

describe('loading the sales routes', () => {
  it('in the state that used to trigger the drop: nothing is dropped and every row survives', async () => {
    await withFixtureDb('slsddl', async ({ client: c }) => {
      await legacyShape(c);
      const before = await rowsOf(c);
      const sql = loadRoutesAgainst(c);
      expect(sql.length, 'the module issued no SQL at all, so this test proved nothing').toBeGreaterThan(0);
      expect(DROPS(sql)).toEqual([]);
      expect(await rowsOf(c)).toEqual(before);
      for (const t of TABLES) expect(await companyType(c, t), t).toBe('uuid');
    });
  }, 90000);

  it('on a database without the tables: they are still created', async () => {
    await withFixtureDb('slsddl', async ({ client: c }) => {
      const sql = loadRoutesAgainst(c);
      expect(DROPS(sql)).toEqual([]);
      for (const t of TABLES) {
        expect(sql.some((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS ${t} `)), `${t} is not created`).toBe(true);
        expect(await companyType(c, t), t).toBe('integer');
        expect((await c.query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n).toBe(0);
      }
    });
  }, 90000);

  it('on the current integer schema: rows are untouched', async () => {
    await withFixtureDb('slsddl', async ({ client: c }) => {
      await c.query(`
        CREATE TABLE sales_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id integer NOT NULL, title varchar(255) NOT NULL);
        CREATE TABLE competitors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id integer NOT NULL, name varchar(255) NOT NULL);
        CREATE TABLE sales_settings (id serial PRIMARY KEY, company_id integer NOT NULL UNIQUE);
        INSERT INTO sales_events (company_id, title) VALUES (1, 'kept');
        INSERT INTO competitors (company_id, name) VALUES (1, 'kept');
        INSERT INTO sales_settings (company_id) VALUES (1);`);
      const before = await rowsOf(c);
      const sql = loadRoutesAgainst(c);
      expect(DROPS(sql)).toEqual([]);
      expect(await rowsOf(c)).toEqual(before);
    });
  }, 90000);

  it('the source holds no such statement', () => {
    expect(readFileSync(ROUTES, 'utf8')).not.toMatch(/DROP\s+TABLE/i);
    expect(readFileSync(ROUTES, 'utf8')).not.toMatch(/DROP\s+COLUMN/i);
  });
});
