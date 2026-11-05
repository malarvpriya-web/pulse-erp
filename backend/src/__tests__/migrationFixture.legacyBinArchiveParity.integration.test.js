/**
 * Migration fixture: 20261105000001_legacy_bin_archive_parity (DB-01C2, manual §239).
 *
 *   - absent table → created with exactly the definition 016a gives it;
 *   - existing table → untouched, rows byte-identical, nothing duplicated or lost;
 *   - it runs twice safely, and with rows 016a really archived from legacy bins;
 *   - down() removes nothing, and up() can run again;
 *   - the source can never drop or empty the archive;
 *   - the application role gets SELECT only, or nothing where no such role exists. The
 *     developer server has no pulse_app role, so the SELECT branch runs only on a
 *     server that does (the DB-01C2 throwaway server).
 *
 * Scratch databases only (helpers/migrationFixtureDb.js).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}
const { withFixtureDb, captureConsole } = await import('./helpers/migrationFixtureDb.js');
const { makeKnexShim } = await import('../config/migrations.js');
const m16a = await import('../database/migrations/20260915000016a_legacy_bin_blank_row_shelf.js');
const parity = await import('../database/migrations/20261105000001_legacy_bin_archive_parity.js');
const FILE = resolve(here, '../database/migrations/20261105000001_legacy_bin_archive_parity.js');

const legacyBins = async (c) => {
  await c.query(`
    CREATE TABLE bin_locations (id serial PRIMARY KEY, zone_id integer, bin_code varchar(30) NOT NULL, row_no varchar(10),
      shelf varchar(10), level varchar(10), max_weight_kg numeric(10,2) DEFAULT 500, current_items jsonb DEFAULT '[]');
    INSERT INTO bin_locations (id, zone_id, bin_code, row_no, shelf, current_items) VALUES
      (1, 1, 'A-1', '1', 'A', '[]'), (2, 1, 'A-2', NULL, NULL, '[{"item_id": 9}]'), (3, 1, 'A-3', '', 'C', '[]'), (4, 1, 'A-4', '2', '  ', '[]');`);
};
const shape = async (c) => {
  const columns = (await c.query(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS dflt
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'legacy_bin_location_archive'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`)).rows;
  const constraints = (await c.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'legacy_bin_location_archive'::regclass AND contype <> 'n' ORDER BY conname`)).rows;
  const indexes = (await c.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'legacy_bin_location_archive' ORDER BY indexname`)).rows;
  return { columns, constraints, indexes };
};
const rows = async (c) => (await c.query(`SELECT * FROM legacy_bin_location_archive ORDER BY id`)).rows;
const down = async (c) => {
  await c.query('BEGIN');
  try { await parity.down(makeKnexShim(c)); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; }
};

describe('20261105000001 legacy_bin_archive_parity', () => {
  it('creates an absent table with exactly the definition 016a gives it', async () => {
    let from016a;
    await withFixtureDb('bkarc', async ({ client: c, apply }) => {
      await legacyBins(c);
      await captureConsole(() => apply(m16a));
      from016a = await shape(c);
    });
    await withFixtureDb('bkarc', async ({ client: c, apply }) => {
      expect((await c.query(`SELECT to_regclass('legacy_bin_location_archive') AS t`)).rows[0].t).toBeNull();
      await captureConsole(() => apply(parity));
      expect(await shape(c)).toEqual(from016a);
      expect(await rows(c)).toEqual([]);
    });
  }, 60000);

  it('leaves rows 016a really archived identical, adds none and loses none, however often it runs', async () => {
    await withFixtureDb('bkarc', async ({ client: c, apply }) => {
      await legacyBins(c);
      await captureConsole(() => apply(m16a));
      const before = await rows(c);
      expect(before.map((r) => r.bin_location_id)).toEqual([2, 3, 4]);
      expect(before[0].row_data).toMatchObject({ id: 2, row_no: null, shelf: null, current_items: [{ item_id: 9 }] });

      await captureConsole(() => apply(parity));
      expect(await rows(c)).toEqual(before);
      await captureConsole(() => apply(parity));
      expect(await rows(c)).toEqual(before);
      // 016a's own idempotence still holds on top of it.
      await expect(c.query(
        `INSERT INTO legacy_bin_location_archive (bin_location_id, row_data, blank_fields, reason) VALUES (2, '{}', '{}', 'duplicate')`))
        .rejects.toMatchObject({ code: '23505' });
    });
  }, 60000);

  it('down keeps the table and every row, and up can run again', async () => {
    await withFixtureDb('bkarc', async ({ client: c, apply }) => {
      await legacyBins(c);
      await captureConsole(() => apply(m16a));
      const before = await rows(c);
      await captureConsole(() => apply(parity));
      await captureConsole(() => down(c));
      expect(await rows(c)).toEqual(before);
      await captureConsole(() => apply(parity));
      expect(await rows(c)).toEqual(before);
    });
  }, 60000);

  it('down on a table the migration itself created also keeps it', async () => {
    await withFixtureDb('bkarc', async ({ client: c, apply }) => {
      await captureConsole(() => apply(parity));
      await captureConsole(() => down(c));
      expect((await c.query(`SELECT to_regclass('legacy_bin_location_archive')::text AS t`)).rows[0].t).toBe('legacy_bin_location_archive');
    });
  }, 60000);

  it('016a still archives afterwards: a database that runs them in the other order loses nothing', async () => {
    await withFixtureDb('bkarc', async ({ client: c, apply }) => {
      await legacyBins(c);
      await captureConsole(() => apply(parity));
      await captureConsole(() => apply(m16a));
      expect((await rows(c)).map((r) => r.bin_location_id)).toEqual([2, 3, 4]);
    });
  }, 60000);

  it('gives the application role SELECT only, or nothing where no such role exists', async () => {
    await withFixtureDb('bkarc', async ({ client: c, apply }) => {
      const { rows: [{ n }] } = await c.query(`SELECT COUNT(*)::int AS n FROM pg_roles WHERE rolname = 'pulse_app'`);
      await captureConsole(() => apply(parity));
      if (n === 0) {
        const { rows: [t] } = await c.query(`SELECT relacl FROM pg_class WHERE relname = 'legacy_bin_location_archive'`);
        expect(t.relacl).toBeNull();
        return;
      }
      const { rows: [p] } = await c.query(`
        SELECT has_table_privilege('pulse_app', 'legacy_bin_location_archive', 'SELECT') AS s,
               has_table_privilege('pulse_app', 'legacy_bin_location_archive', 'INSERT') AS i,
               has_table_privilege('pulse_app', 'legacy_bin_location_archive', 'UPDATE') AS u,
               has_table_privilege('pulse_app', 'legacy_bin_location_archive', 'DELETE') AS d,
               has_table_privilege('pulse_app', 'legacy_bin_location_archive', 'TRUNCATE') AS t`);
      expect(p).toEqual({ s: true, i: false, u: false, d: false, t: false });
    });
  }, 60000);

  it('the source can never drop or empty the archive', () => {
    const code = readFileSync(FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE)\b/i);
  });
});
