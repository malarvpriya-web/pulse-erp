/**
 * Migration fixture: 20260915000017_location_hierarchy →
 * 20260916000001_bin_locations_cutover (§226).
 *
 * Replaces "left exactly one bin table, with the legacy rows carried into it" in
 * traceabilityClosure, which counted the developer database's own legacy bins.
 * What the pair promises, read off their SQL:
 *   017  every legacy bin_locations row whose zone names a live warehouse lands
 *        in warehouse_bins with legacy_bin_location_id pointing back — a new
 *        row, or its existing same-code twin linked rather than duplicated; a
 *        bin whose zone names no warehouse is skipped, never guessed; pick and
 *        cycle-count lines gain the canonical bin_id.
 *   001  refuses outright while ANY legacy bin or line is unmapped; otherwise
 *        carries the columns only the legacy table had, releases the FKs that
 *        pinned it, and drops bin_locations. The legacy id columns on the lines
 *        are kept as the record of where each bin came from.
 *
 * Before-state: baseline.sql (2026-09-10, before both) for the bin tables, plus
 * stock_ledger.from_bin_id/to_bin_id from 20260915000008.
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
const m017 = await import('../database/migrations/20260915000017_location_hierarchy.js');
const m001 = await import('../database/migrations/20260916000001_bin_locations_cutover.js');
const m016a = await import('../database/migrations/20260915000016a_legacy_bin_blank_row_shelf.js');
const { migrationFiles } = await import('../config/migrations.js');
const { default: pool } = await import('../config/db.js');
const { createHash } = await import('node:crypto');

async function beforeState(c) {
  await c.query(`
    CREATE TABLE companies (id SERIAL PRIMARY KEY, name TEXT);
    CREATE TABLE warehouses (
      id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, warehouse_name VARCHAR(200),
      deleted_at TIMESTAMPTZ, company_id INTEGER);
    CREATE TABLE warehouse_zones (
      id SERIAL PRIMARY KEY, warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL, zone_type VARCHAR(20) DEFAULT 'storage', created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE UNIQUE INDEX idx_warehouse_zones_name_unique ON warehouse_zones (warehouse_id, lower(name::text));
    CREATE TABLE bin_locations (
      id SERIAL PRIMARY KEY, zone_id INTEGER REFERENCES warehouse_zones(id) ON DELETE CASCADE,
      bin_code VARCHAR(30) NOT NULL, row_no VARCHAR(10), shelf VARCHAR(10), level VARCHAR(10),
      max_weight_kg NUMERIC(10,2) DEFAULT 500, current_items JSONB DEFAULT '[]', created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE UNIQUE INDEX idx_bin_locations_code_unique ON bin_locations (zone_id, upper(bin_code::text));
    CREATE TABLE warehouse_bins (
      id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      warehouse_id INTEGER NOT NULL, row_code VARCHAR(10) NOT NULL, shelf_code VARCHAR(10) NOT NULL,
      bin_code VARCHAR(20) NOT NULL, capacity NUMERIC(10,3), current_qty NUMERIC(10,3) DEFAULT 0,
      item_id INTEGER, status VARCHAR(20) DEFAULT 'empty', UNIQUE (company_id, warehouse_id, bin_code));
    CREATE TABLE pick_list_lines (id SERIAL PRIMARY KEY, item_id INTEGER,
      bin_location_id INTEGER REFERENCES bin_locations(id), bin_code VARCHAR(30));
    CREATE TABLE cycle_count_lines (id SERIAL PRIMARY KEY, item_id INTEGER,
      bin_location_id INTEGER REFERENCES bin_locations(id), bin_code VARCHAR(30));
    CREATE TABLE stock_ledger (id SERIAL PRIMARY KEY, warehouse_id INTEGER, company_id INTEGER,
      from_bin_id INTEGER, to_bin_id INTEGER);`);
  await c.query(`
    INSERT INTO companies (id, name) VALUES (1, 'Fixture Co');
    INSERT INTO warehouses (id, name, company_id) VALUES (1, 'Main Store', 1);
    INSERT INTO warehouse_zones (id, warehouse_id, name) VALUES (1, 1, 'Racking A');
    INSERT INTO bin_locations (id, zone_id, bin_code, row_no, shelf, level, max_weight_kg, current_items) VALUES
      (1, 1, 'A-01-01', '1', 'A', 'L1', 300, '[{"item_id": 5}]'),     -- no canonical twin yet
      (2, 1, 'A-01-02', '1', 'B', 'L2', 250, '[]');                     -- has a twin below
    INSERT INTO warehouse_bins (id, company_id, warehouse_id, row_code, shelf_code, bin_code, status) VALUES
      (1, 1, 1, '1', 'B', 'A-01-02', 'occupied');
    INSERT INTO pick_list_lines (id, item_id, bin_location_id, bin_code) VALUES (1, 5, 1, 'A-01-01');
    INSERT INTO cycle_count_lines (id, item_id, bin_location_id, bin_code) VALUES (1, 5, 2, 'A-01-02');
    SELECT setval('warehouse_bins_id_seq', 1), setval('bin_locations_id_seq', 2), setval('warehouse_zones_id_seq', 1);`);
}
const bins = async (c) => (await c.query(
  `SELECT id, company_id, warehouse_id, zone_id, row_code, shelf_code, bin_code, status, legacy_bin_location_id AS legacy
     FROM warehouse_bins ORDER BY id`)).rows;
const exists = async (c, rel) => (await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [rel])).rows[0].ok;
const fkExists = async (c, name) => (await c.query(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name])).rows.length === 1;

describe('20260915000017 → 20260916000001 — legacy bins are carried, then the old table retired', () => {
  it('maps every placeable legacy bin exactly once, links its twin, remaps the lines, then cuts over', async () => {
    await withFixtureDb('bins', async ({ client: c, apply }) => {
      await beforeState(c);
      await captureConsole(() => apply(m017));
      expect(await bins(c)).toEqual([
        { id: 1, company_id: 1, warehouse_id: 1, zone_id: 1, row_code: '1', shelf_code: 'B', bin_code: 'A-01-02', status: 'occupied', legacy: 2 },
        { id: 2, company_id: 1, warehouse_id: 1, zone_id: 1, row_code: '1', shelf_code: 'A', bin_code: 'A-01-01', status: 'active',   legacy: 1 },
      ]);
      expect((await c.query(`SELECT bin_location_id, bin_id FROM pick_list_lines`)).rows).toEqual([{ bin_location_id: 1, bin_id: 2 }]);
      expect((await c.query(`SELECT bin_location_id, bin_id FROM cycle_count_lines`)).rows).toEqual([{ bin_location_id: 2, bin_id: 1 }]);

      // The mapping step can be re-run without creating a second canonical bin.
      await captureConsole(() => apply(m017));
      expect((await bins(c)).map((b) => [b.id, b.legacy])).toEqual([[1, 2], [2, 1]]);

      await captureConsole(() => apply(m001));
      expect(await exists(c, 'bin_locations')).toBe(false);
      const { rows: [carried] } = await c.query(`
        SELECT COUNT(*) FILTER (WHERE legacy_bin_location_id IS NOT NULL)::int AS carried,
               COUNT(DISTINCT legacy_bin_location_id)::int AS distinct_carried FROM warehouse_bins`);
      expect(carried).toEqual({ carried: 2, distinct_carried: 2 });     // both legacy rows, none twice
      expect((await c.query(`SELECT id, current_items, max_weight_kg, level_code FROM warehouse_bins ORDER BY id`)).rows).toEqual([
        { id: 1, current_items: [], max_weight_kg: '250.00', level_code: 'L2' },
        { id: 2, current_items: [{ item_id: 5 }], max_weight_kg: '300.00', level_code: 'L1' },
      ]);
      for (const fk of ['warehouse_bins_legacy_fkey', 'pick_list_lines_bin_location_id_fkey', 'cycle_count_lines_bin_location_id_fkey']) {
        expect(await fkExists(c, fk), fk).toBe(false);
      }
      // The lines keep their legacy id as provenance, and resolve through bin_id.
      expect((await c.query(`SELECT bin_location_id, bin_id FROM pick_list_lines`)).rows).toEqual([{ bin_location_id: 1, bin_id: 2 }]);
      expect(await fkExists(c, 'pick_list_lines_bin_id_fkey')).toBe(true);
      expect(await exists(c, 'uq_warehouse_bins_legacy')).toBe(true);
    });
  }, 60000);

  it('refuses the cutover while any legacy bin is unplaced, and leaves everything as it was', async () => {
    await withFixtureDb('bins', async ({ client: c, apply }) => {
      await beforeState(c);
      // A zone that names no warehouse: 017 must skip its bin rather than guess a store.
      await c.query(`INSERT INTO warehouse_zones (id, warehouse_id, name) VALUES (2, NULL, 'Unassigned yard');
                     INSERT INTO bin_locations (id, zone_id, bin_code, row_no, shelf) VALUES (3, 2, 'Y-01', '1', 'A')`);
      await captureConsole(() => apply(m017));
      expect((await c.query(`SELECT COUNT(*)::int n FROM warehouse_bins WHERE legacy_bin_location_id = 3`)).rows[0].n).toBe(0);

      const err = await captureConsole(() => apply(m001)).then(() => null, (e) => e);
      expect(err?.message).toMatch(/^bin_locations cutover refused: 1 unmapped bin\(s\), 0 pick line\(s\) and 0 cycle-count line\(s\)/);
      // Rolled back whole: nothing of the cutover happened.
      expect(await exists(c, 'bin_locations')).toBe(true);
      expect((await c.query(`SELECT COUNT(*)::int n FROM bin_locations`)).rows[0].n).toBe(3);
      expect(await fkExists(c, 'pick_list_lines_bin_location_id_fkey')).toBe(true);
      expect((await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'warehouse_bins' AND column_name = 'current_items'`)).rows).toEqual([]);
    });
  }, 60000);
});

// ═════════════════════════════════════════════════════════════════════════════
// §227 — 20260915000016a: legacy bins with a blank row or shelf
// ═════════════════════════════════════════════════════════════════════════════
const MIG16A = '20260915000016a_legacy_bin_blank_row_shelf';
const ARCHIVE_REASON = "blank row/shelf replaced with '-' (not recorded) so 20260915000017 can carry the bin into warehouse_bins";
/** Legacy bins whose row and/or shelf are NULL, empty or whitespace — all legal in the old schema. */
async function blankBins(c) {
  await c.query(`
    INSERT INTO bin_locations (id, zone_id, bin_code, row_no, shelf, level, max_weight_kg, current_items) VALUES
      (3, 1, 'A-FLOOR-1', NULL,  NULL,  NULL, 400, '[]'),
      (4, 1, 'A-FLOOR-2', '',    'C',   NULL, 400, '[]'),
      (5, 1, 'A-FLOOR-3', '  ',  '   ', 'L0', 400, '[{"item_id": 9}]'),
      (6, 1, 'A-FLOOR-4', '2',   NULL,  NULL, 400, '[]');
    SELECT setval('bin_locations_id_seq', 6);`);
}
const legacyRows = async (c, ids) => (await c.query(
  `SELECT id, to_jsonb(bl) AS j FROM bin_locations bl WHERE id = ANY($1) ORDER BY id`, [ids])).rows;
const archive = async (c) => (await c.query(
  `SELECT bin_location_id AS id, row_data, blank_fields, reason, migration
     FROM legacy_bin_location_archive ORDER BY bin_location_id`)).rows;
const codes = async (c) => (await c.query(`SELECT id, row_no, shelf FROM bin_locations ORDER BY id`)).rows;
const fileChecksum = (p) => createHash('sha256').update(readFileSync(p, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
const logOf = (out) => out.log.join('\n');

describe('20260915000016a — a blank legacy row/shelf is recorded as not-recorded, never guessed', () => {
  it("sorts between 016 and 017 in the runner's own file order, and 017 is byte-for-byte unchanged", async () => {
    const files = migrationFiles();
    const at = (n) => files.indexOf(n);
    expect(at(`${MIG16A}.js`)).toBe(at('20260915000016_component_installations.js') + 1);
    expect(at('20260915000017_location_hierarchy.js')).toBe(at(`${MIG16A}.js`) + 1);
    expect(at('20260916000001_bin_locations_cutover.js')).toBeGreaterThan(at('20260915000017_location_hierarchy.js'));
    // The checksum the existing ledgers recorded for 017, and the one this
    // suite's own database stored when it applied the file.
    const now = fileChecksum(resolve(here, '../database/migrations/20260915000017_location_hierarchy.js'));
    expect(now).toBe('59679c269eb7286a82626490587d618cee76d06e0f037649de7a81eddcaeb391');
    const { rows } = await pool.query(`SELECT checksum FROM schema_migrations WHERE name = '20260915000017_location_hierarchy.js'`);
    expect(rows).toEqual([{ checksum: now }]);
  });

  it("archives each affected row whole, replaces only the blank field with '-', and 017 → 001 then succeed", async () => {
    await withFixtureDb('bins', async ({ client: c, apply }) => {
      await beforeState(c);
      await blankBins(c);
      const originals = await legacyRows(c, [3, 4, 5, 6]);
      const untouched = await legacyRows(c, [1, 2]);

      // Without 016a, 017 fails exactly as reported (and rolls back).
      const failure = await captureConsole(() => apply(m017)).then(() => null, (e) => e);
      expect(failure?.code).toBe('23502');
      expect(failure?.message).toMatch(/null value in column "row_code" of relation "warehouse_bins"/);

      const out = await captureConsole(() => apply(m016a));
      expect(logOf(out)).toMatch(/archived 4 legacy bin\(s\); set a blank row\/shelf to '-' on 4/);

      // The archive holds the ORIGINAL rows, whole, with what was blank.
      const row = (id, i, blank) => ({ id, row_data: originals[i].j, blank_fields: blank, reason: ARCHIVE_REASON, migration: MIG16A });
      expect(await archive(c)).toEqual([
        row(3, 0, ['row_no', 'shelf']), row(4, 1, ['row_no']), row(5, 2, ['row_no', 'shelf']), row(6, 3, ['shelf']),
      ]);
      expect(originals.map((o) => [o.j.row_no, o.j.shelf])).toEqual([[null, null], ['', 'C'], ['  ', '   '], ['2', null]]);
      // Only the blank field changed; populated values and untouched bins kept.
      expect(await codes(c)).toEqual([
        { id: 1, row_no: '1', shelf: 'A' }, { id: 2, row_no: '1', shelf: 'B' },
        { id: 3, row_no: '-', shelf: '-' }, { id: 4, row_no: '-', shelf: 'C' },
        { id: 5, row_no: '-', shelf: '-' }, { id: 6, row_no: '2', shelf: '-' },
      ]);
      expect(await legacyRows(c, [1, 2])).toEqual(untouched);

      // Duplicate-safe: a second run archives nothing more and changes nothing.
      const again = await captureConsole(() => apply(m016a));
      expect(logOf(again)).toMatch(/archived 0 legacy bin\(s\); set a blank row\/shelf to '-' on 0/);
      expect((await archive(c)).map((a) => a.row_data)).toEqual(originals.map((o) => o.j));

      // 017 and the cutover now succeed; the canonical rows carry '-'.
      await captureConsole(async () => { await apply(m017); await apply(m001); });
      expect((await c.query(`SELECT legacy_bin_location_id AS legacy, row_code, shelf_code, bin_code FROM warehouse_bins
                              WHERE legacy_bin_location_id >= 3 ORDER BY legacy_bin_location_id`)).rows).toEqual([
        { legacy: 3, row_code: '-', shelf_code: '-', bin_code: 'A-FLOOR-1' },
        { legacy: 4, row_code: '-', shelf_code: 'C', bin_code: 'A-FLOOR-2' },
        { legacy: 5, row_code: '-', shelf_code: '-', bin_code: 'A-FLOOR-3' },
        { legacy: 6, row_code: '2', shelf_code: '-', bin_code: 'A-FLOOR-4' },
      ]);
      // The legacy-only columns were carried as before.
      expect((await c.query(`SELECT current_items, level_code FROM warehouse_bins WHERE legacy_bin_location_id = 5`)).rows)
        .toEqual([{ current_items: [{ item_id: 9 }], level_code: 'L0' }]);
      // bin_locations is gone; the archive is the surviving record of the originals.
      expect(await exists(c, 'bin_locations')).toBe(false);
      expect((await archive(c)).map((a) => [a.id, a.row_data.row_no, a.row_data.shelf]))
        .toEqual([[3, null, null], [4, '', 'C'], [5, '  ', '   '], [6, '2', null]]);
    });
  }, 60000);

  it('does not make an unplaceable bin placeable: a zone with no warehouse still blocks the cutover', async () => {
    await withFixtureDb('bins', async ({ client: c, apply }) => {
      await beforeState(c);
      await c.query(`INSERT INTO warehouse_zones (id, warehouse_id, name) VALUES (2, NULL, 'Unassigned yard');
                     INSERT INTO bin_locations (id, zone_id, bin_code, row_no, shelf) VALUES (7, 2, 'Y-FLOOR', NULL, ' ')`);
      await captureConsole(() => apply(m016a));
      expect((await archive(c)).map((a) => [a.id, a.blank_fields])).toEqual([[7, ['row_no', 'shelf']]]);
      await captureConsole(() => apply(m017));
      expect((await c.query(`SELECT COUNT(*)::int n FROM warehouse_bins WHERE legacy_bin_location_id = 7`)).rows[0].n).toBe(0);
      const err = await captureConsole(() => apply(m001)).then(() => null, (e) => e);
      expect(err?.message).toMatch(/^bin_locations cutover refused: 1 unmapped bin\(s\)/);
      expect(await exists(c, 'bin_locations')).toBe(true);
      expect((await archive(c)).map((a) => a.id)).toEqual([7]);
    });
  }, 60000);

  it('applied late, after the cutover, it is a no-op (no table, no archive, no error)', async () => {
    await withFixtureDb('bins', async ({ client: c, apply }) => {
      await beforeState(c);
      await captureConsole(async () => { await apply(m017); await apply(m001); });
      const before = await bins(c);
      const out = await captureConsole(() => apply(m016a));
      expect(logOf(out)).toMatch(/bin_locations is gone \(cutover already applied\) — nothing to do/);
      expect(await exists(c, 'legacy_bin_location_archive')).toBe(false);
      expect(await bins(c)).toEqual(before);
      const d = await captureConsole(() => apply({ up: m016a.down }));
      expect(logOf(d)).toMatch(/down: bin_locations is gone — nothing to restore; the archive is kept/);
    });
  }, 60000);

  it('is atomic: a failure part-way leaves no archive and no changed value', async () => {
    await withFixtureDb('bins', async ({ client: c, apply }) => {
      await beforeState(c);
      await blankBins(c);
      // Make the normalising UPDATE fail AFTER the archive INSERT has run.
      await c.query(`CREATE FUNCTION zz_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'zz refused'; END $$;
                     CREATE TRIGGER zz_refuse BEFORE UPDATE ON bin_locations FOR EACH ROW EXECUTE FUNCTION zz_refuse()`);
      const err = await captureConsole(() => apply(m016a)).then(() => null, (e) => e);
      expect(err?.message).toBe('zz refused');
      expect(await exists(c, 'legacy_bin_location_archive')).toBe(false);
      expect((await codes(c)).filter((r) => r.id >= 3)).toEqual([
        { id: 3, row_no: null, shelf: null }, { id: 4, row_no: '', shelf: 'C' },
        { id: 5, row_no: '  ', shelf: '   ' }, { id: 6, row_no: '2', shelf: null },
      ]);
    });
  }, 60000);

  it("down() restores each originally blank field on its own, only where it still holds '-', and keeps the archive", async () => {
    await withFixtureDb('bins', async ({ client: c, apply }) => {
      await beforeState(c);
      await blankBins(c);
      await captureConsole(() => apply(m016a));
      // After the migration someone records bin 4's real row; that must survive.
      await c.query(`UPDATE bin_locations SET row_no = 'R9' WHERE id = 4`);
      await captureConsole(() => apply({ up: m016a.down }));
      expect(await codes(c)).toEqual([
        { id: 1, row_no: '1', shelf: 'A' }, { id: 2, row_no: '1', shelf: 'B' },
        { id: 3, row_no: null, shelf: null },
        { id: 4, row_no: 'R9', shelf: 'C' },
        { id: 5, row_no: '  ', shelf: '   ' },
        { id: 6, row_no: '2', shelf: null },
      ]);
      expect((await archive(c)).map((a) => a.id)).toEqual([3, 4, 5, 6]);
      // Re-applying after a rollback archives nothing twice and normalises again.
      await captureConsole(() => apply(m016a));
      expect((await archive(c)).length).toBe(4);
      expect((await codes(c)).find((r) => r.id === 3)).toEqual({ id: 3, row_no: '-', shelf: '-' });
    });
  }, 60000);
});
