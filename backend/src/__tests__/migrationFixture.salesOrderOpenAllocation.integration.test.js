/**
 * Migration fixture: 20261103000003_sales_order_open_allocation_view.
 *
 * Pins the view's arithmetic in a scratch database, where every row is known:
 *   - each quantity is aggregated on its own, so several lines, pick lists,
 *     ledger rows, allocations and legacy links for one order/item never
 *     multiply one another;
 *   - corrections and cancellations net out of their OWN order only;
 *   - legacy links count only issues referencing the order (never a pick-list
 *     posting), so nothing is counted twice;
 *   - every tenant rule: pick list vs order, ledger row vs pick list, allocation
 *     item vs order, legacy link vs order;
 *   - inactive orders (delivered, completed, closed, cancelled, soft-deleted)
 *     have zero open demand and zero open allocation;
 *   - nothing goes negative; over-allocation is capped at open demand;
 *   - indexes created, re-run is a no-op, down() removes everything.
 * The view itself writes nothing; the "rows unchanged" test proves the migration
 * did not either.
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
const migration = await import('../database/migrations/20261103000003_sales_order_open_allocation_view.js');

// The columns the view reads, as the live schema has them.
async function schema(c) {
  await c.query(`
    CREATE TABLE companies (id INTEGER PRIMARY KEY);
    CREATE TABLE inventory_items (id INTEGER PRIMARY KEY, company_id INTEGER);
    CREATE TABLE sales_orders (id INTEGER PRIMARY KEY, company_id INTEGER, order_status VARCHAR(30), deleted_at TIMESTAMPTZ);
    CREATE TABLE sales_order_items (id INTEGER PRIMARY KEY, order_id INTEGER, item_id INTEGER, quantity NUMERIC(15,3));
    CREATE TABLE pick_lists (id INTEGER PRIMARY KEY, sales_order_id INTEGER, company_id INTEGER);
    CREATE TABLE stock_ledger (id SERIAL PRIMARY KEY, item_id INTEGER, company_id INTEGER,
      reference_type VARCHAR(50), reference_id INTEGER, quantity_in NUMERIC(15,4), quantity_out NUMERIC(15,4));
    CREATE TABLE legacy_fulfilment_links (id SERIAL PRIMARY KEY, company_id INTEGER, sales_order_item_id INTEGER,
      stock_ledger_id INTEGER, quantity NUMERIC(15,4));
    CREATE TABLE inventory_allocations (id SERIAL PRIMARY KEY, item_id INTEGER, reference_type VARCHAR(50),
      reference_id INTEGER, quantity NUMERIC(15,4), allocation_source VARCHAR(30));`);
}
const pick = (c, pl, item, out, inn = 0, co = 1) => c.query(
  `INSERT INTO stock_ledger (item_id, company_id, reference_type, reference_id, quantity_out, quantity_in)
   VALUES ($1, $2, 'pick_list', $3, $4, $5)`, [item, co, pl, out, inn]);
const alloc = (c, order, item, qty, src = 'order_promise') => c.query(
  `INSERT INTO inventory_allocations (item_id, reference_type, reference_id, quantity, allocation_source)
   VALUES ($1, 'sales_order', $2, $3, $4)`, [item, order, qty, src]);
const row = async (c, order, item) => {
  const { rows } = await c.query(
    `SELECT ordered_qty::float AS ordered, picked_out_qty::float AS picked, legacy_shipped_qty::float AS legacy,
            shipped_qty::float AS shipped, allocated_qty::float AS allocated, order_active AS active,
            open_demand_qty::float AS demand, open_alloc_qty::float AS open_alloc
       FROM v_sales_order_open_allocation WHERE sales_order_id = $1 AND item_id = $2`, [order, item]);
  return rows;
};

describe('20261103000003 v_sales_order_open_allocation', () => {
  it('aggregates every source independently: two lines, two pick lists, corrections, two allocations, a legacy link', async () => {
    await withFixtureDb('soalloc', async ({ client: c, apply }) => {
      await schema(c);
      await c.query(`
        INSERT INTO companies VALUES (1);
        INSERT INTO inventory_items VALUES (10, 1);
        INSERT INTO sales_orders VALUES (100, 1, 'confirmed', NULL);
        INSERT INTO sales_order_items VALUES (1001, 100, 10, 30), (1002, 100, 10, 20);   -- 50 ordered over two lines
        INSERT INTO pick_lists VALUES (500, 100, 1), (501, 100, 1);`);
      await pick(c, 500, 10, 12);          // pick list 500: 12 out,
      await pick(c, 500, 10, 0, 4);        //   corrected down by 4  -> net 8
      await pick(c, 501, 10, 7);           // pick list 501: 7      -> net 7
      await alloc(c, 100, 10, 25);
      await alloc(c, 100, 10, 15);         // 40 allocated in two rows
      await c.query(`INSERT INTO stock_ledger (id, item_id, company_id, reference_type, reference_id, quantity_out, quantity_in)
                     VALUES (900, 10, 1, 'sales_order', 100, 5, 0)`);
      await c.query(`INSERT INTO legacy_fulfilment_links (company_id, sales_order_item_id, stock_ledger_id, quantity) VALUES (1, 1002, 900, 5)`);
      await apply(migration);
      // Any multiplication would show here: 2 lines x 3 ledger rows x 2 allocations.
      expect(await row(c, 100, 10)).toEqual([{
        ordered: 50, picked: 15, legacy: 5, shipped: 20, allocated: 40, active: true,
        demand: 30, open_alloc: 20,
      }]);
    });
  });

  it('a correction or cancellation nets out of its own order only', async () => {
    await withFixtureDb('soalloc', async ({ client: c, apply }) => {
      await schema(c);
      await c.query(`
        INSERT INTO companies VALUES (1);
        INSERT INTO inventory_items VALUES (10, 1);
        INSERT INTO sales_orders VALUES (100, 1, 'confirmed', NULL), (101, 1, 'confirmed', NULL);
        INSERT INTO sales_order_items VALUES (1, 100, 10, 40), (2, 101, 10, 40);
        INSERT INTO pick_lists VALUES (500, 100, 1), (501, 101, 1);`);
      await alloc(c, 100, 10, 40); await alloc(c, 101, 10, 40);
      await pick(c, 500, 10, 40); await pick(c, 500, 10, 0, 40);   // order 100: picked, then cancelled -> 0
      await pick(c, 501, 10, 25);                                  // order 101: 25 out
      await apply(migration);
      expect((await row(c, 100, 10))[0]).toMatchObject({ picked: 0, demand: 40, open_alloc: 40 });
      expect((await row(c, 101, 10))[0]).toMatchObject({ picked: 25, demand: 15, open_alloc: 15 });
    });
  });

  it('nothing goes negative, and an allocation larger than what is open is capped', async () => {
    await withFixtureDb('soalloc', async ({ client: c, apply }) => {
      await schema(c);
      await c.query(`
        INSERT INTO companies VALUES (1);
        INSERT INTO inventory_items VALUES (10, 1), (11, 1);
        INSERT INTO sales_orders VALUES (100, 1, 'confirmed', NULL);
        INSERT INTO sales_order_items VALUES (1, 100, 10, 40), (2, 100, 11, 10);
        INSERT INTO pick_lists VALUES (500, 100, 1);`);
      await alloc(c, 100, 10, 40);
      await pick(c, 500, 10, 45);                                  // over-picked
      await alloc(c, 100, 11, 10); await alloc(c, 100, 11, 10); await alloc(c, 100, 11, 10);   // stacked by old re-promises
      await apply(migration);
      expect((await row(c, 100, 10))[0]).toMatchObject({ shipped: 45, demand: 0, open_alloc: 0 });
      expect((await row(c, 100, 11))[0]).toMatchObject({ allocated: 30, demand: 10, open_alloc: 10 });
    });
  });

  it('inactive orders have no open demand and no open allocation', async () => {
    await withFixtureDb('soalloc', async ({ client: c, apply }) => {
      await schema(c);
      await c.query(`INSERT INTO companies VALUES (1); INSERT INTO inventory_items VALUES (10, 1);`);
      const statuses = ['delivered', 'Completed', 'closed', 'CANCELLED', 'confirmed', 'dispatched'];
      for (const [i, st] of statuses.entries()) {
        await c.query(`INSERT INTO sales_orders VALUES ($1, 1, $2, NULL)`, [200 + i, st]);
        await c.query(`INSERT INTO sales_order_items VALUES ($1, $2, 10, 10)`, [300 + i, 200 + i]);
        await alloc(c, 200 + i, 10, 10);
      }
      await c.query(`INSERT INTO sales_orders VALUES (299, 1, 'confirmed', NOW())`);   // soft-deleted
      await c.query(`INSERT INTO sales_order_items VALUES (399, 299, 10, 10)`);
      await alloc(c, 299, 10, 10);
      await apply(migration);
      const { rows } = await c.query(
        `SELECT sales_order_id, order_active, open_demand_qty::float AS d, open_alloc_qty::float AS a
           FROM v_sales_order_open_allocation ORDER BY sales_order_id`);
      expect(rows).toEqual([
        { sales_order_id: 200, order_active: false, d: 0, a: 0 },
        { sales_order_id: 201, order_active: false, d: 0, a: 0 },
        { sales_order_id: 202, order_active: false, d: 0, a: 0 },
        { sales_order_id: 203, order_active: false, d: 0, a: 0 },
        { sales_order_id: 204, order_active: true,  d: 10, a: 10 },
        { sales_order_id: 205, order_active: true,  d: 10, a: 10 },   // partial-dispatch status is still open
        { sales_order_id: 299, order_active: false, d: 0, a: 0 },
      ]);
    });
  });

  it('tenant rules: foreign pick lists, ledger rows, allocations and legacy links never count', async () => {
    await withFixtureDb('soalloc', async ({ client: c, apply }) => {
      await schema(c);
      await c.query(`
        INSERT INTO companies VALUES (1), (2);
        INSERT INTO inventory_items VALUES (10, 1), (20, 2);
        INSERT INTO sales_orders VALUES (100, 1, 'confirmed', NULL);
        INSERT INTO sales_order_items VALUES (1, 100, 10, 40), (2, 100, 20, 40);
        INSERT INTO pick_lists VALUES (500, 100, 1), (600, 100, 2);   -- 600: company 2's list naming company 1's order`);
      await pick(c, 500, 10, 5, 0, 1);       // counts
      await pick(c, 500, 10, 9, 0, 2);       // ledger row of company 2 on company 1's list: ignored
      await pick(c, 600, 10, 11, 0, 2);      // company 2's pick list: ignored
      await alloc(c, 100, 20, 40);           // allocation of company 2's item on company 1's order: ignored
      await c.query(`INSERT INTO stock_ledger (id, item_id, company_id, reference_type, reference_id, quantity_out, quantity_in)
                     VALUES (901, 10, 1, 'sales_order', 100, 3, 0), (902, 10, 1, 'pick_list', 500, 0, 0)`);
      await c.query(`INSERT INTO legacy_fulfilment_links (company_id, sales_order_item_id, stock_ledger_id, quantity) VALUES
        (2, 1, 901, 3),     -- wrong company on the link: ignored
        (1, 1, 902, 6)      -- points at a pick-list row: ignored (would double count)`);
      await apply(migration);
      expect((await row(c, 100, 10))[0]).toMatchObject({ picked: 5, legacy: 0, shipped: 5, demand: 35 });
      expect((await row(c, 100, 20))[0]).toMatchObject({ allocated: 0, open_alloc: 0 });
    });
  });

  it('a pick list with no order, and consumption / advanced allocations, change nothing', async () => {
    await withFixtureDb('soalloc', async ({ client: c, apply }) => {
      await schema(c);
      await c.query(`
        INSERT INTO companies VALUES (1); INSERT INTO inventory_items VALUES (10, 1);
        INSERT INTO sales_orders VALUES (100, 1, 'confirmed', NULL);
        INSERT INTO sales_order_items VALUES (1, 100, 10, 40);
        INSERT INTO pick_lists VALUES (500, NULL, 1);`);
      await pick(c, 500, 10, 30);
      await alloc(c, 100, 10, 7, 'consumption');
      await alloc(c, 100, 10, 9, 'advanced_manual');
      await alloc(c, 100, 10, 11, null);
      await apply(migration);
      expect((await row(c, 100, 10))[0]).toMatchObject({ picked: 0, allocated: 0, demand: 40, open_alloc: 0 });
    });
  });

  it('creates the indexes, changes no row, is idempotent, and down() removes it all', async () => {
    await withFixtureDb('soalloc', async ({ client: c, apply }) => {
      await schema(c);
      await c.query(`INSERT INTO sales_orders VALUES (100, 1, 'confirmed', NULL); INSERT INTO pick_lists VALUES (500, 100, 1);`);
      await pick(c, 500, 10, 4);
      const snapshot = async () => (await c.query(
        `SELECT (SELECT json_agg(s ORDER BY id) FROM stock_ledger s) AS l, (SELECT json_agg(p ORDER BY id) FROM pick_lists p) AS p`)).rows[0];
      const before = await snapshot();
      await apply(migration);
      await apply(migration);
      expect(await snapshot()).toEqual(before);
      const idx = async () => (await c.query(
        `SELECT indexname FROM pg_indexes WHERE indexname IN
           ('idx_stock_ledger_pick_list_ref','idx_pick_lists_sales_order','idx_inv_alloc_order_promise') ORDER BY 1`)).rows.map(r => r.indexname);
      expect(await idx()).toEqual(['idx_inv_alloc_order_promise', 'idx_pick_lists_sales_order', 'idx_stock_ledger_pick_list_ref']);
      await c.query('BEGIN'); await migration.down(makeKnexShim(c)); await c.query('COMMIT');
      expect(await idx()).toEqual([]);
      const { rows: [v] } = await c.query(`SELECT to_regclass('v_sales_order_open_allocation') AS v`);
      expect(v.v).toBeNull();
      expect(await snapshot()).toEqual(before);
    });
  });
});
