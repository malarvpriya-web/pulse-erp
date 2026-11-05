/**
 * integration.allocationSource.test.js — inventory_allocations.allocation_source
 * (migration 20261103000002) and the readers that honour it.
 *
 * The defect: POST /inventory/consumption writes a ledger issue AND an allocation
 * row. A trigger (trg_stock_ledger_sync) already lowers inventory_items.current_stock
 * for the issue, and MRP and order promising then subtracted the allocation as
 * committed stock on top — every consumption counted twice, permanently.
 *
 * What is proven here, against the real services and routes:
 *   - each writer states its source, and a body value can never choose it;
 *   - consumption lowers MRP on-hand and promisable stock exactly ONCE;
 *   - order_promise, advanced_manual and historical NULL rows still count;
 *   - the three consumption reads list consumption and NULL rows only.
 *
 * The NULL ("legacy") row: the migration's NOT VALID constraint refuses any new
 * row without a source, which is the point. To stand in for a row that existed
 * before the migration, beforeAll drops and re-adds that constraint around one
 * INSERT, inside ONE transaction with a lock_timeout — DDL is transactional, so
 * no other session ever sees the table without it — and then asserts it is back,
 * still NOT VALID. Only this suite's TAG rows are involved.
 *
 * Throwaway rows under TAG, swept before and after. Run with
 * `npm run test:db` (isolated pulse_e2e database, migrated by
 * `node scripts/test-db/setup.mjs`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool }      = await import('../config/db.js');
const { default: invRouter } = await import('../modules/inventory/routes/inventory.routes.js');
const { runMRP }             = await import('../modules/production/mrpEngine.service.js');
const { promiseOrder, releaseBackorders } = await import('../modules/sales/services/orderPromising.service.js');

const TAG = 'ZZALSRC';
const ids = {};

function appFor(companyId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 2000000010, id: 2000000010, company_id: companyId, roles: ['admin'], role: 'admin' };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/inventory', invRouter);
  return app;
}

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const co = rows.map(r => r.id);
  const items = `(SELECT id FROM inventory_items WHERE item_code LIKE $1)`;
  await pool.query(`DELETE FROM inventory_allocations WHERE item_id IN ${items}`, [`${TAG}%`]);
  await pool.query(`DELETE FROM stock_ledger WHERE item_id IN ${items}`, [`${TAG}%`]);
  if (co.length) {
    for (const t of ['mrp_time_phased', 'mrp_exceptions', 'mrp_planned_orders', 'mrp_runs', 'backorders']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [co]).catch(() => {});
    }
    await pool.query(`DELETE FROM sales_order_items WHERE order_id IN (SELECT id FROM sales_orders WHERE company_id = ANY($1))`, [co]);
    await pool.query(`DELETE FROM sales_orders WHERE company_id = ANY($1)`, [co]);
  }
  await pool.query(`DELETE FROM inventory_items WHERE item_code LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM warehouses WHERE warehouse_name LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM projects WHERE project_code LIKE $1`, [`${TAG}%`]);
  if (co.length) await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

// A buy item with a huge safety stock and no lead time, so MRP plans it in
// bucket 0 and that planned order's on_hand is exactly current_stock - committed.
async function makeItem(key) {
  const { rows: [i] } = await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, item_type,
                                  reorder_level, safety_stock, lead_time_days, standard_cost, is_active)
     VALUES ($1, $1, $2, 'NOS', 'raw_material', 0, 100000, 0, 10, true) RETURNING id`, [`${TAG}-${key}`, ids.co]);
  ids[key] = i.id;
  // Opening stock through the ledger, so the trigger sets current_stock to 100.
  await pool.query(
    `INSERT INTO stock_ledger (item_id, warehouse_id, company_id, transaction_type, quantity_in, quantity_out,
                               balance_qty, rate, value, transaction_date, remarks)
     VALUES ($1, $2, $3, 'opening', 100, 0, 100, 10, 1000, CURRENT_DATE, $4)`, [i.id, ids.wh, ids.co, `${TAG} opening`]);
}

async function makeOrder(itemKey, qty) {
  const { rows: [so] } = await pool.query(
    `INSERT INTO sales_orders (order_number, company_id, customer_name, order_status, subtotal, tax_amount, total_amount)
     VALUES ($1, $2, 'ZZ Customer', 'confirmed', 0, 0, 0) RETURNING id, order_number`,
    [`${TAG}-SO-${itemKey}-${qty}-${Date.now()}`, ids.co]);
  const { rows: [line] } = await pool.query(
    `INSERT INTO sales_order_items (order_id, item_id, item_code, description, quantity, unit_price, tax_rate, total_amount)
     VALUES ($1, $2, $3, 'ZZ goods', $4, 0, 0, 0) RETURNING id`, [so.id, ids[itemKey], `${TAG}-${itemKey}`, qty]);
  return { id: so.id, number: so.order_number, lineId: line.id };
}

const stockOf = async (key) =>
  Number((await pool.query(`SELECT current_stock FROM inventory_items WHERE id = $1`, [ids[key]])).rows[0].current_stock);
const sourcesOf = async (key) => (await pool.query(
  `SELECT allocation_source, quantity::float AS qty FROM inventory_allocations WHERE item_id = $1 ORDER BY id`, [ids[key]])).rows;
const consume = (key, quantity, extra = {}) => request(appFor(ids.co)).post('/inventory/consumption')
  .send({ item_id: ids[key], warehouse_id: ids.wh, quantity, notes: `${TAG} consume`, ...extra });

// What promising sees, writing nothing (allocate: false).
async function promisable(key) {
  const order = await makeOrder(key, 1);
  const r = await promiseOrder({ orderId: order.id, companyId: ids.co, allocate: false });
  const line = r.lines?.find(l => l.item_id === ids[key]) ?? r.results?.find(l => l.item_id === ids[key]);
  return { on_hand: line.on_hand, already_allocated: line.already_allocated, available_now: line.available_now };
}

// MRP's opening on-hand for an item: current_stock minus committed demand.
async function mrpOnHand(key) {
  const r = await runMRP({ companyId: ids.co, horizonDays: 14, bucketDays: 7, runCapacityPlan: false, actor: { name: 'vitest' } });
  const first = r.plannedOrders.filter(p => p.item_id === ids[key]).sort((a, b) => a.bucket_index - b.bucket_index)[0];
  return Number(first.on_hand);
}

// A legacy (pre-migration) row: see the header for why this needs the constraint lifted.
async function insertLegacyRow(itemKey, qty, extra = {}) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL lock_timeout = '15s'`);
    await c.query(`ALTER TABLE inventory_allocations DROP CONSTRAINT inventory_allocations_source_required`);
    await c.query(
      `INSERT INTO inventory_allocations (item_id, warehouse_id, allocation_type, reference_type, quantity, rate, allocation_date, purpose, project_id)
       VALUES ($1, $2, 'project', 'project', $3, 10, CURRENT_DATE, $4, $5)`,
      [ids[itemKey], ids.wh, qty, `${TAG} legacy`, extra.project_id ?? null]);
    await c.query(`ALTER TABLE inventory_allocations ADD CONSTRAINT inventory_allocations_source_required
                   CHECK (allocation_source IS NOT NULL) NOT VALID`);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await sweep();
  const { rows: [c] } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co`, `${TAG}C`]);
  ids.co = c.id;
  const { rows: [w] } = await pool.query(
    `INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1, $1, $2) RETURNING id`, [`${TAG} W`, c.id]);
  ids.wh = w.id;
  const { rows: [p] } = await pool.query(
    `INSERT INTO projects (project_code, project_name, company_id) VALUES ($1, $1, $2) RETURNING id`, [`${TAG}-P`, c.id]);
  ids.proj = p.id;
  for (const k of ['once', 'mixed', 'backorder', 'writers', 'reads']) await makeItem(k);
}, 60_000);

afterAll(async () => { await sweep(); }, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
describe('the migration is in force on this database', () => {
  it('the column exists; the value check is validated; the required check is NOT VALID', async () => {
    const { rows } = await pool.query(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = 'inventory_allocations'::regclass AND conname LIKE 'inventory_allocations_source_%' ORDER BY conname`);
    expect(rows).toEqual([
      { conname: 'inventory_allocations_source_chk', convalidated: true },
      { conname: 'inventory_allocations_source_required', convalidated: false },
    ]);
  });

  it('a new row without a source, or with an unknown one, is refused', async () => {
    const insert = (src) => pool.query(
      `INSERT INTO inventory_allocations (item_id, warehouse_id, quantity, rate, allocation_date, purpose, allocation_source)
       VALUES ($1, $2, 1, 0, CURRENT_DATE, $3, $4)`, [ids.writers, ids.wh, `${TAG} probe`, src]);
    await expect(insert(null)).rejects.toMatchObject({ code: '23514', constraint: 'inventory_allocations_source_required' });
    await expect(insert('bogus')).rejects.toMatchObject({ code: '23514', constraint: 'inventory_allocations_source_chk' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('every writer states its source; a body value never chooses it', () => {
  it('POST /consumption writes consumption, even when the body says order_promise', async () => {
    const res = await consume('writers', 2, { allocation_source: 'order_promise' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.allocation_source).toBe('consumption');
  });

  it('POST /inventory/advanced/allocations writes advanced_manual, even when the body says consumption', async () => {
    const res = await request(appFor(ids.co)).post('/inventory/advanced/allocations').send({
      item_id: ids.writers, warehouse_id: ids.wh, allocation_type: 'project', reference_type: 'project',
      quantity: 3, rate: 10, allocation_date: new Date().toISOString().slice(0, 10), purpose: `${TAG} adv`,
      allocation_source: 'consumption',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.allocation_source).toBe('advanced_manual');
  });

  it('promiseOrder writes order_promise', async () => {
    const order = await makeOrder('writers', 4);
    await promiseOrder({ orderId: order.id, companyId: ids.co, allocate: true });
    const { rows } = await pool.query(
      `SELECT allocation_source, quantity::float AS qty FROM inventory_allocations
        WHERE item_id = $1 AND reference_type = 'sales_order' AND reference_id = $2`, [ids.writers, order.id]);
    expect(rows).toEqual([{ allocation_source: 'order_promise', qty: 4 }]);
  });

  it('releaseBackorders writes order_promise', async () => {
    const order = await makeOrder('writers', 6);
    await pool.query(
      `INSERT INTO backorders (company_id, sales_order_id, sales_order_item_id, order_number, item_id, qty_backordered, qty_released, status)
       VALUES ($1, $2, $3, $4, $5, 6, 0, 'open')`, [ids.co, order.id, order.lineId, order.number, ids.writers]);
    await releaseBackorders({ companyId: ids.co, itemId: ids.writers });
    const { rows } = await pool.query(
      `SELECT allocation_source FROM inventory_allocations
        WHERE item_id = $1 AND reference_id = $2 AND purpose LIKE 'Backorder release%'`, [ids.writers, order.id]);
    expect(rows).toEqual([{ allocation_source: 'order_promise' }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('consumption lowers stock exactly once — MRP and order promising', () => {
  it('the ledger issue alone lowers current_stock: 100 → 70', async () => {
    expect(await stockOf('once')).toBe(100);
    expect((await consume('once', 30)).status).toBe(201);
    expect(await stockOf('once')).toBe(70);
    expect(await sourcesOf('once')).toEqual([{ allocation_source: 'consumption', qty: 30 }]);
  });

  it('order promising: 70 promisable, not 40 — the consumption is not "already allocated"', async () => {
    expect(await promisable('once')).toEqual({ on_hand: 70, already_allocated: 0, available_now: 70 });
  });

  it('MRP: on-hand 70, not 40', async () => {
    expect(await mrpOnHand('once')).toBe(70);
  });

  it('releaseBackorders frees what is really free: a 60 backorder closes in full (old code released 40)', async () => {
    const order = await makeOrder('backorder', 60);
    expect((await consume('backorder', 30)).status).toBe(201);          // 100 → 70 on hand
    const { rows: [b] } = await pool.query(
      `INSERT INTO backorders (company_id, sales_order_id, sales_order_item_id, order_number, item_id, qty_backordered, qty_released, status)
       VALUES ($1, $2, $3, $4, $5, 60, 0, 'open') RETURNING id`, [ids.co, order.id, order.lineId, order.number, ids.backorder]);
    await releaseBackorders({ companyId: ids.co, itemId: ids.backorder });
    const { rows: [after] } = await pool.query(
      `SELECT status, qty_released::float AS released FROM backorders WHERE id = $1`, [b.id]);
    expect(after).toEqual({ status: 'closed', released: 60 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('commitments still count: order_promise, advanced_manual and legacy NULL', () => {
  beforeAll(async () => {
    const order = await makeOrder('mixed', 10);
    await promiseOrder({ orderId: order.id, companyId: ids.co, allocate: true });            // order_promise 10
    const adv = await request(appFor(ids.co)).post('/inventory/advanced/allocations').send({
      item_id: ids.mixed, warehouse_id: ids.wh, allocation_type: 'project', reference_type: 'project',
      quantity: 7, rate: 10, allocation_date: new Date().toISOString().slice(0, 10), purpose: `${TAG} adv`,
    });                                                                                       // advanced_manual 7
    expect(adv.status).toBe(201);
    await insertLegacyRow('mixed', 11);                                                       // NULL 11
    expect((await consume('mixed', 5)).status).toBe(201);                                     // consumption 5: 100 → 95
  }, 60_000);

  it('the required-source constraint is back, still NOT VALID, after the legacy insert', async () => {
    const { rows: [c] } = await pool.query(
      `SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'inventory_allocations'::regclass AND conname = 'inventory_allocations_source_required'`);
    expect(c).toEqual({ convalidated: false });
  });

  it('the item carries one row of each kind', async () => {
    expect((await sourcesOf('mixed')).map(r => [r.allocation_source, r.qty]).sort()).toEqual(
      [['advanced_manual', 7], ['consumption', 5], ['order_promise', 10], [null, 11]].sort());
  });

  it('order promising: 95 on hand, 28 allocated (10 + 7 + 11), 67 promisable', async () => {
    expect(await promisable('mixed')).toEqual({ on_hand: 95, already_allocated: 28, available_now: 67 });
  });

  it('MRP: on-hand 77 — advanced_manual and legacy subtracted; the order_promise is not (its order is demand)', async () => {
    // 95 on hand - 7 advanced_manual - 11 legacy NULL. The 10 promised to the
    // order is NOT subtracted as committed stock: since the order-promise
    // lifecycle fix (v_sales_order_open_allocation), that order's open line is
    // MRP gross demand instead, so subtracting the allocation too would count
    // the same order twice. Consumption still reaches MRP only through the ledger.
    expect(await mrpOnHand('mixed')).toBe(77);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the consumption reads list consumption and legacy rows only', () => {
  beforeAll(async () => {
    expect((await consume('reads', 2, { reference_type: 'project', project_id: ids.proj })).status).toBe(201);
    await insertLegacyRow('reads', 3, { project_id: ids.proj });
    const order = await makeOrder('reads', 4);
    await promiseOrder({ orderId: order.id, companyId: ids.co, allocate: true });            // order_promise 4
    // An order_promise row WITH a project: no writer makes one today, but the
    // by-project read must exclude it by its source, not by luck.
    await pool.query(
      `INSERT INTO inventory_allocations (item_id, warehouse_id, allocation_type, reference_type, quantity, rate, allocation_date, purpose, project_id, allocation_source)
       VALUES ($1, $2, 'sales_order', 'sales_order', 9, 10, CURRENT_DATE, $3, $4, 'order_promise')`,
      [ids.reads, ids.wh, `${TAG} promise with project`, ids.proj]);
    await request(appFor(ids.co)).post('/inventory/advanced/allocations').send({
      item_id: ids.reads, warehouse_id: ids.wh, allocation_type: 'project', reference_type: 'project',
      quantity: 5, rate: 10, allocation_date: new Date().toISOString().slice(0, 10), purpose: `${TAG} adv`,
    });                                                                                       // advanced_manual 5
  }, 60_000);

  const readRows = async (url) => {
    const res = await request(appFor(ids.co)).get(url);
    expect(res.status).toBe(200);
    return res.body.filter(r => r.item_code === `${TAG}-reads`);
  };

  it('GET /consumption: the consumption and the legacy row, each with its allocation_source', async () => {
    const rows = await readRows('/inventory/consumption');
    expect(rows.map(r => [r.allocation_source, Number(r.quantity)]).sort()).toEqual([['consumption', 2], [null, 3]].sort());
  });

  it('GET /consumption/by-type: the same two, with allocation_source returned', async () => {
    const rows = await readRows('/inventory/consumption/by-type');
    expect(rows.map(r => [r.allocation_source, Number(r.quantity)]).sort()).toEqual([['consumption', 2], [null, 3]].sort());
  });

  it('GET /consumption/by-project: 5 consumed over 2 transactions, 1 of them legacy — no promise rows', async () => {
    const rows = await readRows('/inventory/consumption/by-project');
    expect(rows).toHaveLength(1);
    expect({ total: Number(rows[0].total_consumed), n: Number(rows[0].transaction_count), legacy: rows[0].legacy_transaction_count })
      .toEqual({ total: 5, n: 2, legacy: 1 });
  });
});
