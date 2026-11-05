/**
 * Migration fixture: 20261103000002_inventory_allocation_source.
 *
 * What the migration promises, read off its SQL:
 *   - adds inventory_allocations.allocation_source, nullable;
 *   - inventory_allocations_source_chk: a present value is one of
 *     consumption | order_promise | advanced_manual (validated: every row passes,
 *     because every existing row is NULL);
 *   - inventory_allocations_source_required: NOT NULL, added NOT VALID — every
 *     existing row is grandfathered untouched, every NEW row must state a source;
 *   - touches no existing row; re-running is a no-op; down() removes all three.
 *
 * Runs in a scratch database (helpers/migrationFixtureDb.js), so the real
 * inventory_allocations in the shared test database is never altered here.
 * Before-state: the table's shape in baseline.sql, cut to the columns that matter.
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
const { withFixtureDb } = await import('./helpers/migrationFixtureDb.js');
const { makeKnexShim } = await import('../config/migrations.js');
const migration = await import('../database/migrations/20261103000002_inventory_allocation_source.js');

async function beforeState(c) {
  await c.query(`
    CREATE TABLE inventory_allocations (
      id SERIAL PRIMARY KEY, item_id INTEGER NOT NULL, batch_id INTEGER, warehouse_id INTEGER NOT NULL,
      allocation_type VARCHAR(50), reference_type VARCHAR(50), reference_id INTEGER,
      quantity NUMERIC(15,4) DEFAULT 0 NOT NULL, rate NUMERIC(15,4) DEFAULT 0 NOT NULL,
      allocation_date DATE DEFAULT CURRENT_DATE NOT NULL, allocated_by INTEGER, purpose TEXT,
      created_at TIMESTAMPTZ DEFAULT now(), project_id INTEGER,
      CONSTRAINT inventory_allocations_rate_nonneg_chk CHECK (rate IS NULL OR rate >= 0));`);
  // History as each writer left it, including the case allocation_type cannot
  // classify: a consumption logged with type 'sales_order' before Stage 5B.
  await c.query(`
    INSERT INTO inventory_allocations (item_id, warehouse_id, allocation_type, reference_type, reference_id, quantity, rate, allocation_date, allocated_by, purpose, created_at, project_id) VALUES
      (1, 1, 'manual',      'manual',      NULL, 3,  12.5, '2026-09-01', 7,    'Material consumption',  '2026-09-01 10:00:00+00', NULL),
      (1, 1, 'sales_order', 'sales_order', 41,   5,  10,   '2026-09-02', NULL, 'Order SO-41 line 9',    '2026-09-02 10:00:00+00', NULL),
      (2, 1, 'sales_order', 'sales_order', 41,   2,  10,   '2026-09-03', 7,    'logged via consumption','2026-09-03 10:00:00+00', NULL),
      (2, 1, 'project',     'project',     8,    4,  0,    '2026-09-04', 7,    NULL,                    '2026-09-04 10:00:00+00', 8)`);
}
const allRows = async (c) => (await c.query(
  `SELECT to_jsonb(a) - 'allocation_source' AS row, allocation_source FROM inventory_allocations a ORDER BY id`)).rows;
const constraints = async (c) => (await c.query(
  `SELECT conname, convalidated FROM pg_constraint
    WHERE conrelid = 'inventory_allocations'::regclass AND conname LIKE 'inventory_allocations_source_%' ORDER BY conname`)).rows;
const insert = (c, src) => c.query(
  `INSERT INTO inventory_allocations (item_id, warehouse_id, quantity, allocation_source) VALUES (1, 1, 1, $1)`, [src]);

describe('20261103000002 inventory_allocation_source', () => {
  it('adds a nullable column and both constraints, the required one NOT VALID', async () => {
    await withFixtureDb('alsrc', async ({ client: c, apply }) => {
      await beforeState(c);
      await apply(migration);
      const { rows: [col] } = await c.query(
        `SELECT data_type, character_maximum_length AS len, is_nullable, column_default
           FROM information_schema.columns WHERE table_name = 'inventory_allocations' AND column_name = 'allocation_source'`);
      expect(col).toEqual({ data_type: 'character varying', len: 30, is_nullable: 'YES', column_default: null });
      expect(await constraints(c)).toEqual([
        { conname: 'inventory_allocations_source_chk', convalidated: true },
        { conname: 'inventory_allocations_source_required', convalidated: false },
      ]);
    });
  });

  it('leaves every existing row byte-for-byte as it was, with allocation_source NULL', async () => {
    await withFixtureDb('alsrc', async ({ client: c, apply }) => {
      await beforeState(c);
      const before = (await c.query(`SELECT to_jsonb(a) AS row FROM inventory_allocations a ORDER BY id`)).rows;
      await apply(migration);
      const after = await allRows(c);
      expect(after.map(r => r.row)).toEqual(before.map(r => r.row));
      expect(after.every(r => r.allocation_source === null)).toBe(true);
      // ...and they stay readable and countable, which is all the readers do with them.
      const { rows: [s] } = await c.query(
        `SELECT SUM(quantity)::float AS q FROM inventory_allocations WHERE allocation_source IS DISTINCT FROM 'consumption'`);
      expect(s.q).toBe(14);
    });
  });

  it('refuses a new row without a source, or with an unknown one; accepts each of the three', async () => {
    await withFixtureDb('alsrc', async ({ client: c, apply }) => {
      await beforeState(c);
      await apply(migration);
      await expect(insert(c, null)).rejects.toMatchObject({ code: '23514', constraint: 'inventory_allocations_source_required' });
      await expect(insert(c, 'bogus')).rejects.toMatchObject({ code: '23514', constraint: 'inventory_allocations_source_chk' });
      await expect(insert(c, 'Consumption')).rejects.toMatchObject({ code: '23514' });     // exact values only
      for (const src of ['consumption', 'order_promise', 'advanced_manual']) await insert(c, src);
      const { rows } = await c.query(`SELECT allocation_source FROM inventory_allocations WHERE id > 4 ORDER BY id`);
      expect(rows.map(r => r.allocation_source)).toEqual(['consumption', 'order_promise', 'advanced_manual']);
    });
  });

  it('NOT VALID semantics: a grandfathered row cannot be UPDATED without a source (allocations are append-only)', async () => {
    await withFixtureDb('alsrc', async ({ client: c, apply }) => {
      await beforeState(c);
      await apply(migration);
      await expect(c.query(`UPDATE inventory_allocations SET purpose = 'x' WHERE id = 1`))
        .rejects.toMatchObject({ code: '23514', constraint: 'inventory_allocations_source_required' });
      const { rows: [r] } = await c.query(`SELECT purpose FROM inventory_allocations WHERE id = 1`);
      expect(r.purpose).toBe('Material consumption');
    });
  });

  it('is idempotent: running it twice changes nothing and raises nothing', async () => {
    await withFixtureDb('alsrc', async ({ client: c, apply }) => {
      await beforeState(c);
      await apply(migration);
      const once = { cons: await constraints(c), rows: await allRows(c) };
      await apply(migration);
      expect({ cons: await constraints(c), rows: await allRows(c) }).toEqual(once);
    });
  });

  it('down() removes both constraints and the column, leaving the rows otherwise intact', async () => {
    await withFixtureDb('alsrc', async ({ client: c, apply }) => {
      await beforeState(c);
      const before = (await c.query(`SELECT to_jsonb(a) AS row FROM inventory_allocations a ORDER BY id`)).rows;
      await apply(migration);
      await c.query('BEGIN');
      await migration.down(makeKnexShim(c));
      await c.query('COMMIT');
      expect(await constraints(c)).toEqual([]);
      const after = (await c.query(`SELECT to_jsonb(a) AS row FROM inventory_allocations a ORDER BY id`)).rows;
      expect(after).toEqual(before);
    });
  });

  it('does nothing on a database without the table', async () => {
    await withFixtureDb('alsrc', async ({ client: c, apply }) => {
      await apply(migration);
      const { rows: [t] } = await c.query(`SELECT to_regclass('inventory_allocations') AS t`);
      expect(t.t).toBeNull();
    });
  });
});
