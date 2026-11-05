/**
 * integration.orderPromiseLifecycle.test.js — the order-promise allocation
 * lifecycle, against the real pick-list routes, promising service and MRP.
 *
 * The defect: an order-promise allocation was never released. Stock leaves at
 * PICK (pick-list 'dispatch' postings), yet the allocation stayed, so promising
 * and MRP subtracted stock that had already gone; re-promising stacked
 * allocations; cancelled and deleted orders kept theirs, and their backorders
 * kept receiving stock; a partly released backorder was never picked up again;
 * and MRP counted an allocated order twice (as demand AND as committed stock),
 * because sales_order_items.fulfilled_qty is never written.
 *
 * The fix derives what is still reserved (v_sales_order_open_allocation):
 * allocated − net pick-list postings − approved legacy shipments, capped at
 * open demand, zero for inactive orders. Nothing is "released" by a writer.
 *
 * Proven here: release on pick, partial picks over several lists, corrections
 * and cancellations restoring only their own order, over-picks, unlinked pick
 * lists, idempotent re-promise, several lines of one item, backorder release
 * (including partial), cancel / delete / inactive orders, MRP counting demand
 * once, concurrent promises, promises racing picks (lock order), and tenancy.
 *
 * Throwaway companies under TAG, swept before and after. Run with
 * `npm run test:db` after `node scripts/test-db/setup.mjs`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

// Same auth stand-in as integration.salesDispatchDuplication: the routes' own
// permission checks run, against a permission list on the fake user.
const allows = (req, key) => req.user?.perms === '*' || (req.user?.perms || []).includes(key);
vi.mock('../middlewares/auth.middleware.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    verifyToken: (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Unauthorized' })),
    requirePermission: (module, action) => (req, res, next) =>
      (allows(req, `${module}:${action}`) ? next() : res.status(403).json({ error: 'Forbidden' })),
  };
});

const { default: pool }            = await import('../config/db.js');
const { default: warehouseRouter } = await import('../modules/warehouse/warehouse.routes.js');
const { default: salesRouter }     = await import('../modules/sales/routes/sales.routes.js');
const promising                    = await import('../modules/sales/services/orderPromising.service.js');
const { runMRP }                   = await import('../modules/production/mrpEngine.service.js');

const TAG = 'ZZOPL';
const co = {};       // 'A' | 'B' -> { id, wh, bin }
const items = {};    // key -> { id, co }

function appAs(companyId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 1, id: 1, roles: ['admin'], company_id: companyId, perms: '*' };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/warehouse', warehouseRouter);
  app.use('/sales', salesRouter);
  return app;
}

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  const its = `(SELECT id FROM inventory_items WHERE company_id = ANY($1))`;
  const del = async (sql) => { try { await pool.query(sql, [ids]); } catch { /* ordering — next pass */ } };
  for (let pass = 0; pass < 3; pass++) {
    await del(`DELETE FROM inventory_allocations WHERE item_id IN ${its}`);
    await del(`DELETE FROM backorders WHERE company_id = ANY($1)`);
    await del(`DELETE FROM demand_forecast_consumption WHERE company_id = ANY($1)`);
    for (const t of ['mrp_time_phased', 'mrp_exceptions', 'mrp_planned_orders', 'mrp_runs']) await del(`DELETE FROM ${t} WHERE company_id = ANY($1)`);
    await del(`DELETE FROM inventory_fifo_consumption WHERE item_id IN ${its}`);
    await del(`DELETE FROM inventory_fifo_layers WHERE item_id IN ${its}`);
    await del(`DELETE FROM stock_ledger WHERE item_id IN ${its}`);
    await del(`DELETE FROM shipments WHERE company_id = ANY($1)`);
    await del(`DELETE FROM package_lines WHERE company_id = ANY($1)`);
    await del(`DELETE FROM packages WHERE company_id = ANY($1)`);
    await del(`DELETE FROM pick_list_lines WHERE pick_list_id IN (SELECT id FROM pick_lists WHERE company_id = ANY($1))`);
    await del(`DELETE FROM pick_lists WHERE company_id = ANY($1)`);
    await del(`DELETE FROM sales_order_items WHERE order_id IN (SELECT id FROM sales_orders WHERE company_id = ANY($1))`);
    await del(`DELETE FROM sales_orders WHERE company_id = ANY($1)`);
    await del(`DELETE FROM audit_logs WHERE company_id = ANY($1)`);
    await del(`DELETE FROM inventory_items WHERE company_id = ANY($1)`);
    await del(`DELETE FROM warehouse_bins WHERE company_id = ANY($1)`);
    await del(`DELETE FROM warehouse_zones WHERE warehouse_id IN (SELECT id FROM warehouses WHERE company_id = ANY($1))`);
    await del(`DELETE FROM warehouses WHERE company_id = ANY($1)`);
  }
  const { rows: fks } = await pool.query(`
    SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu  ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'companies'`);
  for (let pass = 0; pass < 2; pass++) {
    for (const { table_name, column_name } of fks) {
      try { await pool.query(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1)`, [ids]); } catch { /* next pass */ }
    }
  }
  await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [ids]);
}

async function makeCompany(s) {
  const id = (await pool.query(`INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${s}`, `${TAG}${s}`])).rows[0].id;
  const wh = (await pool.query(`INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1, $1, $2) RETURNING id`, [`${TAG} WH ${s}`, id])).rows[0].id;
  const zone = (await pool.query(`INSERT INTO warehouse_zones (warehouse_id, name) VALUES ($1, $2) RETURNING id`, [wh, `${TAG} Z ${s}`])).rows[0].id;
  const bin = (await pool.query(
    `INSERT INTO warehouse_bins (company_id, warehouse_id, zone_id, row_code, shelf_code, bin_code)
     VALUES ($1, $2, $3, 'R1', 'S1', $4) RETURNING id`, [id, wh, zone, `${TAG}-BIN-${s}`])).rows[0].id;
  co[s] = { id, wh, bin };
}

// An item with opening stock through the ledger (the trigger sets current_stock)
// and a FIFO layer, so picks are costed exactly as in production.
async function makeItem(key, s, qty, { safety = 0 } = {}) {
  const c = co[s];
  const id = (await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, item_type, standard_cost,
                                  safety_stock, lead_time_days, reorder_level, is_active)
     VALUES ($1, $1, $2, 'NOS', 'raw_material', 10, $3, 0, 0, true) RETURNING id`, [`${TAG}-${key}`, c.id, safety])).rows[0].id;
  if (qty > 0) await receive({ id, co: s }, qty);
  items[key] = { id, co: s };
  return items[key];
}
async function receive(item, qty) {
  const c = co[item.co];
  await pool.query(
    `INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, quantity_in, quantity_out, rate, transaction_date, company_id, remarks)
     VALUES ($1, $2, 'opening', $3, 0, 10, CURRENT_DATE, $4, $5)`, [item.id, c.wh, qty, c.id, `${TAG} receipt`]);
  await pool.query(
    `INSERT INTO inventory_fifo_layers (company_id, item_id, warehouse_id, received_date, qty_received, qty_remaining, unit_cost, source_type)
     VALUES ($1, $2, $3, CURRENT_DATE, $4, $4, 10, 'opening')`, [c.id, item.id, c.wh, qty]);
}

let soSeq = 0;
async function makeOrder(s, lines, { status = 'confirmed' } = {}) {
  soSeq++;
  const c = co[s];
  const { rows: [so] } = await pool.query(
    `INSERT INTO sales_orders (order_number, company_id, customer_name, order_status, subtotal, tax_amount, total_amount, order_date)
     VALUES ($1, $2, 'ZZ Customer', $3, 0, 0, 0, CURRENT_DATE) RETURNING id`, [`${TAG}-SO-${s}-${soSeq}-${Date.now()}`, c.id, status]);
  const lineIds = [];
  for (const [key, qty] of lines) {
    const it = typeof key === 'string' ? items[key] : key;
    const { rows: [l] } = await pool.query(
      `INSERT INTO sales_order_items (order_id, item_id, item_code, description, quantity, unit_price, tax_rate, total_amount)
       VALUES ($1, $2, $3, 'ZZ goods', $4, 0, 0, 0) RETURNING id`, [so.id, it.id, `${TAG}-x`, qty]);
    lineIds.push(l.id);
  }
  return { id: so.id, co: s, lineIds };
}

const promise = (order, allocate = true) => promising.promiseOrder({ orderId: order.id, companyId: co[order.co].id, allocate });
const stockOf = async (key) => Number((await pool.query(`SELECT current_stock FROM inventory_items WHERE id = $1`, [items[key].id])).rows[0].current_stock);
const open = async (order, key) => {
  const { rows: [r] } = await pool.query(
    `SELECT open_alloc_qty::float AS alloc, open_demand_qty::float AS demand, shipped_qty::float AS shipped
       FROM v_sales_order_open_allocation WHERE sales_order_id = $1 AND item_id = $2`, [order.id, items[key].id]);
  return r;
};
// What promising would offer a NEW order of this item right now (writes nothing).
async function freeOf(key) {
  const probe = await makeOrder(items[key].co, [[key, 1]]);
  const r = await promise(probe, false);
  await pool.query(`UPDATE sales_orders SET order_status = 'cancelled' WHERE id = $1`, [probe.id]);   // keep it out of later figures
  return r.lines[0].available_now;
}
const allocRows = async (order) => (await pool.query(
  `SELECT quantity::float AS q FROM inventory_allocations WHERE reference_type = 'sales_order' AND reference_id = $1 AND allocation_source = 'order_promise' ORDER BY id`, [order.id])).rows.map(r => r.q);

async function pickList(order, key, required, { linked = true } = {}) {
  const c = co[items[key].co];
  const res = await request(appAs(c.id)).post('/warehouse/pick-lists').send({
    sales_order_id: linked ? order.id : null, sales_order_ref: linked ? `SO-${order.id}` : null,
    lines: [{ item_id: items[key].id, item_name: `${TAG}-${key}`, bin_location_id: c.bin, bin_code: 'B', required_qty: required }],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const { rows: [line] } = await pool.query(`SELECT id FROM pick_list_lines WHERE pick_list_id = $1`, [res.body.id]);
  return { id: res.body.id, lineId: line.id, key, co: items[key].co };
}
async function multiPickList(order, keys, required) {
  const c = co[order.co];
  const res = await request(appAs(c.id)).post('/warehouse/pick-lists').send({
    sales_order_id: order.id, sales_order_ref: `SO-${order.id}`,
    lines: keys.map(k => ({ item_id: items[k].id, item_name: `${TAG}-${k}`, bin_location_id: c.bin, bin_code: 'B', required_qty: required })),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const { rows } = await pool.query(`SELECT id, item_id FROM pick_list_lines WHERE pick_list_id = $1 ORDER BY id`, [res.body.id]);
  return { id: res.body.id, lines: rows, co: order.co };
}
const pick = (pl, qty) => request(appAs(co[pl.co].id)).put(`/warehouse/pick-lists/${pl.id}/pick`)
  .send({ lines: [{ line_id: pl.lineId, picked_qty: qty, bin_location_id: co[pl.co].bin, item_id: items[pl.key].id, item_name: `${TAG}-${pl.key}` }] });
const setStatus = (pl, status) => request(appAs(co[pl.co].id)).patch(`/warehouse/pick-lists/${pl.id}/status`).send({ status });

beforeAll(async () => {
  await sweep();
  await makeCompany('A');
  await makeCompany('B');
}, 60_000);
afterAll(async () => { await sweep(); }, 120_000);

// ─────────────────────────────────────────────────────────────────────────────
describe('released on pick — not at dispatch, not never', () => {
  it('a full pick releases the reservation; dispatch changes nothing further', async () => {
    await makeItem('full', 'A', 100);
    const o = await makeOrder('A', [['full', 40]]);
    await promise(o);
    expect(await allocRows(o)).toEqual([40]);
    expect(await freeOf('full')).toBe(60);
    const pl = await pickList(o, 'full', 40);
    expect((await pick(pl, 40)).status).toBe(200);
    expect(await stockOf('full')).toBe(60);
    expect(await open(o, 'full')).toEqual({ alloc: 0, demand: 0, shipped: 40 });
    expect(await freeOf('full')).toBe(60);                 // old: 20 (60 on hand - the 40 still "allocated")
    expect((await setStatus(pl, 'dispatched')).status).toBe(200);
    expect(await freeOf('full')).toBe(60);
    // Partial-dispatch status behaviour is untouched: the order reads dispatched.
    const { rows: [so] } = await pool.query(`SELECT order_status FROM sales_orders WHERE id = $1`, [o.id]);
    expect(so.order_status).toBe('dispatched');
  });

  it('partial picks over two pick lists release exactly what each took', async () => {
    await makeItem('part', 'A', 100);
    const o = await makeOrder('A', [['part', 40]]);
    await promise(o);
    const pl1 = await pickList(o, 'part', 15);
    await pick(pl1, 15);
    expect(await open(o, 'part')).toMatchObject({ alloc: 25, demand: 25 });
    expect(await freeOf('part')).toBe(60);                 // 85 on hand - 25 still reserved
    const pl2 = await pickList(o, 'part', 25);
    await pick(pl2, 25);
    expect(await open(o, 'part')).toMatchObject({ alloc: 0, demand: 0 });
    expect(await freeOf('part')).toBe(60);
  });

  it('a correction or a cancelled pick list restores only its own order', async () => {
    await makeItem('corr', 'A', 100);
    const o1 = await makeOrder('A', [['corr', 30]]);
    const o2 = await makeOrder('A', [['corr', 30]]);
    await promise(o1); await promise(o2);
    const pl = await pickList(o1, 'corr', 30);
    await pick(pl, 30);
    expect(await open(o1, 'corr')).toMatchObject({ alloc: 0 });
    await pick(pl, 10);                                    // corrected down: 20 back on the shelf
    expect(await stockOf('corr')).toBe(90);
    expect(await open(o1, 'corr')).toMatchObject({ alloc: 20, shipped: 10 });
    expect(await open(o2, 'corr')).toMatchObject({ alloc: 30, shipped: 0 });
    expect((await setStatus(pl, 'cancelled')).status).toBe(200);
    expect(await stockOf('corr')).toBe(100);
    expect(await open(o1, 'corr')).toMatchObject({ alloc: 30, shipped: 0 });
    expect(await open(o2, 'corr')).toMatchObject({ alloc: 30 });
    expect(await freeOf('corr')).toBe(40);
  });

  it('an over-pick reserves nothing and never goes negative', async () => {
    await makeItem('over', 'A', 100);
    const o = await makeOrder('A', [['over', 10]]);
    await promise(o);
    const pl = await pickList(o, 'over', 15);
    await pick(pl, 15);
    expect(await open(o, 'over')).toEqual({ alloc: 0, demand: 0, shipped: 15 });
    expect(await freeOf('over')).toBe(85);
  });

  it('a pick list with no order releases nothing', async () => {
    await makeItem('unl', 'A', 100);
    const o = await makeOrder('A', [['unl', 20]]);
    await promise(o);
    const pl = await pickList(o, 'unl', 5, { linked: false });
    await pick(pl, 5);
    expect(await open(o, 'unl')).toMatchObject({ alloc: 20, shipped: 0 });
    expect(await freeOf('unl')).toBe(75);                  // 95 on hand - 20 reserved
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('re-promise and several lines of one item', () => {
  it('promising three times allocates once', async () => {
    await makeItem('rep', 'A', 100);
    const o = await makeOrder('A', [['rep', 40]]);
    await promise(o); await promise(o); await promise(o);
    expect(await allocRows(o)).toEqual([40]);              // old: [40, 40, 20]
    const { rows: [l] } = await pool.query(`SELECT allocated_qty::float AS a FROM sales_order_items WHERE id = $1`, [o.lineIds[0]]);
    expect(l.a).toBe(40);
    expect(await freeOf('rep')).toBe(60);
  });

  it('two lines of one item share its figures; a pick and a re-promise allocate nothing new', async () => {
    await makeItem('multi', 'A', 100);
    const o = await makeOrder('A', [['multi', 30], ['multi', 20]]);
    const r = await promise(o);
    expect(r.lines.map(l => l.allocated)).toEqual([30, 20]);
    expect(await open(o, 'multi')).toMatchObject({ alloc: 50, demand: 50 });
    const pl = await pickList(o, 'multi', 35);
    await pick(pl, 35);
    expect(await open(o, 'multi')).toMatchObject({ alloc: 15, demand: 15, shipped: 35 });
    const again = await promise(o);
    expect(again.lines.map(l => [l.quantity, l.allocated ?? 0])).toEqual([[0, 0], [15, 0]]);
    expect(await allocRows(o)).toEqual([30, 20]);
    const { rows } = await pool.query(`SELECT allocated_qty::float AS a FROM sales_order_items WHERE order_id = $1 ORDER BY id`, [o.id]);
    expect(rows.map(x => x.a)).toEqual([0, 15]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('backorders', () => {
  it('a partly released backorder is picked up by the next release', async () => {
    const it0 = await makeItem('bo', 'A', 10);
    const o = await makeOrder('A', [['bo', 25]]);
    await promise(o);
    const bo = async () => (await pool.query(
      `SELECT status, qty_backordered::float AS b, qty_released::float AS r FROM backorders WHERE sales_order_id = $1`, [o.id])).rows[0];
    expect(await bo()).toEqual({ status: 'open', b: 15, r: 0 });
    await receive(it0, 5);
    await promising.releaseBackorders({ companyId: co.A.id, itemId: it0.id });
    expect(await bo()).toEqual({ status: 'partial', b: 15, r: 5 });
    await receive(it0, 20);
    await promising.releaseBackorders({ companyId: co.A.id, itemId: it0.id });
    expect(await bo()).toEqual({ status: 'closed', b: 15, r: 15 });   // old: stuck at partial
    expect(await open(o, 'bo')).toMatchObject({ alloc: 25, demand: 25 });
  });

  it('cancelling an order cancels its backorders, and release gives it nothing', async () => {
    const it0 = await makeItem('bocx', 'A', 0);
    const o = await makeOrder('A', [['bocx', 10]]);
    await promise(o);
    const res = await request(appAs(co.A.id)).patch(`/sales/orders/${o.id}/cancel`).send({ reason: `${TAG} test` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { rows: [b] } = await pool.query(`SELECT status FROM backorders WHERE sales_order_id = $1`, [o.id]);
    expect(b.status).toBe('cancelled');
    const { rows: [l] } = await pool.query(`SELECT allocated_qty::float AS a, backordered_qty::float AS b FROM sales_order_items WHERE id = $1`, [o.lineIds[0]]);
    expect(l).toEqual({ a: 0, b: 0 });
    await receive(it0, 10);
    const rel = await promising.releaseBackorders({ companyId: co.A.id, itemId: it0.id });
    expect(rel.released).toBe(0);
    expect(await allocRows(o)).toEqual([]);
  });

  it('a soft-deleted order cancels its backorders and reserves nothing', async () => {
    const it0 = await makeItem('bodel', 'A', 4);
    const o = await makeOrder('A', [['bodel', 10]]);
    await promise(o);                                      // 4 allocated, 6 backordered
    expect((await request(appAs(co.A.id)).delete(`/sales/orders/${o.id}`)).status).toBe(200);
    const { rows: [b] } = await pool.query(`SELECT status FROM backorders WHERE sales_order_id = $1`, [o.id]);
    expect(b.status).toBe('cancelled');
    expect(await open(o, 'bodel')).toEqual({ alloc: 0, demand: 0, shipped: 0 });
    expect(await freeOf('bodel')).toBe(4);
    await receive(it0, 6);
    expect((await promising.releaseBackorders({ companyId: co.A.id, itemId: it0.id })).released).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('inactive orders reserve nothing and are not promised', () => {
  for (const status of ['delivered', 'completed', 'closed', 'cancelled']) {
    it(`${status}: open allocation 0, stock free again, a re-promise writes nothing`, async () => {
      await makeItem(`ina-${status}`, 'A', 100);
      const o = await makeOrder('A', [[`ina-${status}`, 40]]);
      await promise(o);
      expect(await freeOf(`ina-${status}`)).toBe(60);
      await pool.query(`UPDATE sales_orders SET order_status = $2 WHERE id = $1`, [o.id, status]);
      expect(await open(o, `ina-${status}`)).toMatchObject({ alloc: 0, demand: 0 });
      expect(await freeOf(`ina-${status}`)).toBe(100);
      const r = await promise(o);
      expect(r.inactive).toBe(true);
      expect(await allocRows(o)).toEqual([40]);           // the old row is kept, untouched, and reads as 0
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MRP counts sales-order demand once', () => {
  const plan = async (key) => {
    const r = await runMRP({ companyId: co.A.id, horizonDays: 14, bucketDays: 7, runCapacityPlan: false, actor: { name: 'vitest' } });
    const first = r.plannedOrders.filter(p => p.item_id === items[key].id).sort((a, b) => a.bucket_index - b.bucket_index)[0];
    return { on_hand: Number(first.on_hand), gross: Number(first.gross_requirement) };
  };

  it('allocated, unpicked: demand 40 once — the allocation is not also subtracted from on-hand', async () => {
    await makeItem('mrp', 'A', 100, { safety: 100000 });
    const o = await makeOrder('A', [['mrp', 40]]);
    await promise(o);
    expect(await plan('mrp')).toEqual({ on_hand: 100, gross: 40 });   // old: on_hand 60, gross 40
    items.mrp.order = o;
  });

  it('after the full pick: on-hand 60 and no demand left for the order', async () => {
    const pl = await pickList(items.mrp.order, 'mrp', 40);
    await pick(pl, 40);
    // MRP plans only items with demand, so a second, unallocated order of 5
    // keeps the item in the plan. Only that 5 is demand now; the picked order
    // contributes neither demand nor a commitment.
    await makeOrder('A', [['mrp', 5]]);
    expect(await plan('mrp')).toEqual({ on_hand: 60, gross: 5 });     // old: on_hand 20, gross 45
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('concurrency', () => {
  it('concurrent promises on one item never reserve more than is free', async () => {
    for (let round = 0; round < 5; round++) {
      await makeItem(`race${round}`, 'A', 100);
      const os = await Promise.all([0, 1, 2].map(() => makeOrder('A', [[`race${round}`, 60]])));
      const results = await Promise.allSettled(os.map(o => promise(o)));
      expect(results.filter(r => r.status === 'rejected').map(r => r.reason?.message)).toEqual([]);
      const { rows: [s] } = await pool.query(
        `SELECT SUM(open_alloc_qty)::float AS q FROM v_sales_order_open_allocation WHERE item_id = $1`, [items[`race${round}`].id]);
      expect(s.q).toBe(100);                               // 60 + 40 + 0, never 180
    }
  }, 120_000);

  it('a pick posts its items in ascending id order — the order promises lock them in', async () => {
    // The deadlock-freedom argument in one deterministic check: every ledger
    // posting locks its item row (trg_stock_ledger_sync), and promising locks
    // items ascending, so a pick must post ascending too, whatever its line order.
    const ks = ['ord1', 'ord2', 'ord3'];
    for (const k of ks) await makeItem(k, 'A', 50);
    const o = await makeOrder('A', ks.map(k => [k, 5]));
    const pl = await multiPickList(o, [...ks].reverse(), 5);       // lines in DESCENDING item id
    const res = await request(appAs(co.A.id)).put(`/warehouse/pick-lists/${pl.id}/pick`).send({
      lines: pl.lines.map(l => ({ line_id: l.id, picked_qty: 5, bin_location_id: co.A.bin, item_id: l.item_id, item_name: 'x' })) });
    expect(res.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT item_id FROM stock_ledger WHERE reference_type = 'pick_list' AND reference_id = $1 ORDER BY id`, [pl.id]);
    const posted = rows.map(r => r.item_id);
    expect(posted).toHaveLength(3);
    expect(posted).toEqual([...posted].sort((a, b) => a - b));
  });

  it('promises racing picks on the same items (opposite line order) finish without deadlock', async () => {
    for (let round = 0; round < 5; round++) {
      const k1 = `dl${round}a`, k2 = `dl${round}b`;
      await makeItem(k1, 'A', 100); await makeItem(k2, 'A', 100);
      const pickOrder = await makeOrder('A', [[k2, 30], [k1, 30]]);
      await promise(pickOrder);
      const pl = await multiPickList(pickOrder, [k2, k1], 30);   // lines in DESCENDING item id
      const other = await makeOrder('A', [[k1, 50], [k2, 50]]);   // promised in ascending id
      const [p, q] = await Promise.allSettled([
        request(appAs(co.A.id)).put(`/warehouse/pick-lists/${pl.id}/pick`).send({
          lines: pl.lines.map(l => ({ line_id: l.id, picked_qty: 30, bin_location_id: co.A.bin, item_id: l.item_id, item_name: 'x' })) }),
        promise(other),
      ]);
      expect(p.status === 'fulfilled' && p.value.status, JSON.stringify(p.value?.body ?? p.reason?.message)).toBe(200);
      expect(q.status, q.reason?.message).toBe('fulfilled');
      // Whichever ran first, the end state is the same: 70 on hand each, the
      // picked order reserves nothing, the other order holds 50 of each.
      for (const k of [k1, k2]) {
        expect(await stockOf(k)).toBe(70);
        expect(await open(pickOrder, k)).toMatchObject({ alloc: 0 });
        expect(await open(other, k)).toMatchObject({ alloc: 50 });
      }
    }
  }, 180_000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('tenancy', () => {
  it('an order line naming another company\'s item is not promised against that company\'s stock', async () => {
    await makeItem('tenA', 'A', 100);
    const freeBefore = await freeOf('tenA');
    const foreign = await makeOrder('B', [['tenA', 30]]);
    const r = await promise(foreign);
    expect(r.lines[0]).toMatchObject({ promised: false, reason: 'item belongs to another company' });
    expect(r.lines[0].available_now).toBeUndefined();     // A's figures are not read out to B
    expect(await allocRows(foreign)).toEqual([]);
    expect(await freeOf('tenA')).toBe(freeBefore);
  });

  it('releasing company A\'s backorders never touches company B\'s', async () => {
    const itB = await makeItem('tenB', 'B', 0);
    const oB = await makeOrder('B', [['tenB', 10]]);
    await promise(oB);
    await receive(itB, 10);
    await promising.releaseBackorders({ companyId: co.A.id });
    const { rows: [b] } = await pool.query(`SELECT status, qty_released::float AS r FROM backorders WHERE sales_order_id = $1`, [oB.id]);
    expect(b).toEqual({ status: 'open', r: 0 });
    await promising.releaseBackorders({ companyId: co.B.id });
    const { rows: [b2] } = await pool.query(`SELECT status FROM backorders WHERE sales_order_id = $1`, [oB.id]);
    expect(b2.status).toBe('closed');
  });

  it('the view only ever reports an order under its own company', async () => {
    const { rows } = await pool.query(
      `SELECT DISTINCT v.company_id, so.company_id AS order_company
         FROM v_sales_order_open_allocation v JOIN sales_orders so ON so.id = v.sales_order_id
        WHERE so.company_id = ANY($1)`, [[co.A.id, co.B.id]]);
    expect(rows.every(r => r.company_id === r.order_company)).toBe(true);
  });
});
