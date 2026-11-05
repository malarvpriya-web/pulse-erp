/**
 * integration.warehouseLifecycle.test.js — pick, pack, quality gate, dispatch,
 * invoice, cancel; tenancy; and the historical pick-list diagnostic. Against
 * the REAL database, through the REAL routers.
 *
 * WHAT IS PROVED (Phase 3C)
 *   - Cancelling a pick list returns exactly the stock it still has out — none
 *     before picking, the partial quantity after a partial pick, the corrected
 *     quantity after a correction — once, however often or concurrently it is
 *     asked; a packed or dispatched list cannot be cancelled.
 *   - PATCH /pick-lists/:id/status runs the real workflow step: 'dispatched'
 *     goes through the quality gate and creates the shipment, 'packed' builds
 *     the package, 'cancelled' returns the stock. Illegal transitions are 4xx.
 *   - A sales order is invoiced once (retries and concurrent requests included);
 *     invoicing never moves warehouse-picked stock; an invoice line carrying
 *     item_id is refused; an invoice cannot be "cancelled" or "paid" by editing.
 *   - Every sales-order, pick-list and shipment write is scoped to the caller's
 *     company, with positive pairs; view-only callers are refused.
 *   - The historical diagnostic classifies lists correctly and writes nothing.
 *
 * Every refusal is checked against the database, not only the status code.
 * Permission gates are stubbed to grant exactly the caller's permissions;
 * tenant scope is the routes' own. Storage is stubbed so no file is written.
 *
 * Cleanup deletes only this suite's two companies' rows, table by table, and
 * falls back to the generic FK sweep only if the company row is still pinned —
 * a smaller lock footprint than sweeping every company-referencing table, which
 * matters because suites share one database and run in parallel.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

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
vi.mock('../services/StorageService.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, uploadFile: vi.fn(async () => 'stub://pod.jpg') };
});

const { default: pool }            = await import('../config/db.js');
const { default: warehouseRouter } = await import('../modules/warehouse/warehouse.routes.js');
const { default: salesRouter }     = await import('../modules/sales/routes/sales.routes.js');
const { default: financeRouter }   = await import('../modules/finance/routes/finance.routes.js');
const { default: logisticsRouter } = await import('../modules/logistics/logistics.routes.js');
const { default: scmRouter }       = await import('../modules/logistics/scmPlanning.routes.js');
const { default: invoiceService }  = await import('../modules/finance/services/invoice.service.js');
const { diagnosePickListPostings } = await import('../modules/warehouse/pickListWorkflow.service.js');
const semantics                    = await import('../modules/inventory/services/ledgerSemantics.js');
const { uploadFile }               = await import('../services/StorageService.js');

const TAG = 'ZZWHLC';

function appAs(companyId, perms = '*') {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    req.user  = { userId: 1, id: 1, roles: ['admin'], company_id: companyId, perms };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/warehouse', warehouseRouter);
  app.use('/sales', salesRouter);
  app.use('/finance', financeRouter);
  app.use('/logistics', logisticsRouter);
  app.use('/scm', scmRouter);
  return app;
}

const co = {};

// ── cleanup ──────────────────────────────────────────────────────────────────
async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  const items = `(SELECT id FROM inventory_items WHERE company_id = ANY($1))`;
  const steps = [
    `DELETE FROM inventory_fifo_consumption WHERE item_id IN ${items}`,
    `DELETE FROM inventory_fifo_layers WHERE item_id IN ${items}`,
    `DELETE FROM stock_ledger WHERE item_id IN ${items}`,
    `DELETE FROM route_stops WHERE route_id IN (SELECT id FROM delivery_routes WHERE company_id = ANY($1))`,
    `DELETE FROM delivery_routes WHERE company_id = ANY($1)`,
    `DELETE FROM shipments WHERE company_id = ANY($1)`,
    `DELETE FROM package_lines WHERE company_id = ANY($1)`,
    `DELETE FROM packages WHERE company_id = ANY($1)`,
    `DELETE FROM pick_list_lines WHERE pick_list_id IN (SELECT id FROM pick_lists WHERE company_id = ANY($1))`,
    `DELETE FROM pick_lists WHERE company_id = ANY($1)`,
    `DELETE FROM quality_tests WHERE production_order_id IN (SELECT id FROM production_orders WHERE company_id = ANY($1))`,
    `DELETE FROM production_orders WHERE company_id = ANY($1)`,
    `DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id = ANY($1))`,
    `DELETE FROM invoices WHERE company_id = ANY($1)`,
    `DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id = ANY($1))`,
    `DELETE FROM journal_entries WHERE company_id = ANY($1)`,
    `DELETE FROM sales_order_items WHERE order_id IN (SELECT id FROM sales_orders WHERE company_id = ANY($1))`,
    `DELETE FROM sales_orders WHERE company_id = ANY($1)`,
    `DELETE FROM quality_settings WHERE company_id = ANY($1)`,
    `DELETE FROM audit_logs WHERE company_id = ANY($1)`,
    `DELETE FROM inventory_items WHERE company_id = ANY($1)`,
    `DELETE FROM warehouse_bins WHERE company_id = ANY($1)`,
    `DELETE FROM warehouse_zones WHERE warehouse_id IN (SELECT id FROM warehouses WHERE company_id = ANY($1))`,
    `DELETE FROM warehouses WHERE company_id = ANY($1)`,
    `DELETE FROM interview_questions WHERE company_id = ANY($1)`,
  ];
  for (const sql of steps) { try { await pool.query(sql, [ids]); } catch { /* table absent or order — fallback below */ } }
  try {
    await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [ids]);
  } catch {
    // Something an imported router seeded still pins the companies: only now
    // sweep every company-referencing table, for these ids only.
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
}

// ── fixtures ─────────────────────────────────────────────────────────────────
async function makeCompany(s) {
  const id = (await pool.query(`INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`,
    [`${TAG} Co ${s}`, `${TAG}${s}`])).rows[0].id;
  const wh = (await pool.query(
    `INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1, $1, $2) RETURNING id`, [`${TAG} WH ${s}`, id])).rows[0].id;
  const zone = (await pool.query(
    `INSERT INTO warehouse_zones (warehouse_id, name) VALUES ($1, $2) RETURNING id`, [wh, `${TAG} Z ${s}`])).rows[0].id;
  const bin = (await pool.query(
    `INSERT INTO warehouse_bins (company_id, warehouse_id, zone_id, row_code, shelf_code, bin_code)
     VALUES ($1, $2, $3, 'R1', 'S1', $4) RETURNING id`, [id, wh, zone, `${TAG}-BIN-${s}`])).rows[0].id;
  const item = (await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, standard_cost)
     VALUES ($1, $2, $3, 'NOS', 100) RETURNING id`, [`${TAG}-${s}-ITEM`, `${TAG} Item ${s}`, id])).rows[0].id;
  await pool.query(
    `INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, quantity_in, quantity_out, rate,
                               transaction_date, company_id, remarks)
     VALUES ($1, $2, 'opening', 500, 0, 100, CURRENT_DATE - 30, $3, $4)`, [item, wh, id, `${TAG} opening`]);
  co[s] = { id, wh, zone, bin, item };
}
let seq = 0;
async function makeSalesOrder(c, status = 'confirmed') {
  seq++;
  const so = (await pool.query(
    `INSERT INTO sales_orders (order_number, company_id, customer_name, order_status, subtotal, tax_amount, total_amount)
     VALUES ($1, $2, 'ZZ Customer', $3, 500, 0, 500) RETURNING id`, [`${TAG}-SO-${c.id}-${seq}`, c.id, status])).rows[0].id;
  await pool.query(
    `INSERT INTO sales_order_items (order_id, item_code, description, quantity, unit_price, tax_rate, total_amount)
     VALUES ($1, 'ZZ', 'ZZ goods', 5, 100, 0, 500)`, [so]);
  return so;
}
async function makePickList(c, requiredQty = 5, salesOrderId = null) {
  const res = await request(appAs(c.id)).post('/warehouse/pick-lists').send({
    sales_order_id: salesOrderId,
    lines: [{ item_id: c.item, item_name: `${TAG} Item`, bin_location_id: c.bin, bin_code: 'B', required_qty: requiredQty }],
  });
  expect(res.status).toBe(201);
  const { rows: [line] } = await pool.query(`SELECT id FROM pick_list_lines WHERE pick_list_id = $1`, [res.body.id]);
  return { id: res.body.id, lineId: line.id };
}
const pick = (c, pl, qty, perms = '*') => request(appAs(c.id, perms)).put(`/warehouse/pick-lists/${pl.id}/pick`)
  .send({ lines: [{ line_id: pl.lineId, picked_qty: qty, bin_location_id: c.bin, item_id: c.item, item_name: `${TAG} Item` }] });
const setStatus = (c, pl, status, perms = '*', body = {}) =>
  request(appAs(c.id, perms)).patch(`/warehouse/pick-lists/${pl.id}/status`).send({ status, ...body });

const netOut = async (plId) => Number((await pool.query(
  `SELECT COALESCE(SUM(quantity_out - quantity_in), 0)::float AS q FROM stock_ledger
    WHERE reference_type = 'pick_list' AND reference_id = $1`, [plId])).rows[0].q);
const listDemand = async (plId) => Number((await pool.query(
  `SELECT COALESCE(SUM(${semantics.demandQtySql()}), 0)::float AS d FROM stock_ledger
    WHERE reference_type = 'pick_list' AND reference_id = $1`, [plId])).rows[0].d);
const stockOf = async (itemId) => Number((await pool.query(
  `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS q FROM stock_ledger WHERE item_id = $1`, [itemId])).rows[0].q);
const statusOf = async (plId) => (await pool.query(`SELECT status FROM pick_lists WHERE id = $1`, [plId])).rows[0].status;
const count = async (sql, params) => Number((await pool.query(sql, params)).rows[0].n);

beforeAll(async () => {
  await sweep();
  await makeCompany('A');
  await makeCompany('B');
}, 60_000);
afterAll(async () => { await sweep(); }, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
describe('pick-list cancellation returns exactly what is still out', () => {
  it('before picking: cancels with no stock movement', async () => {
    const pl = await makePickList(co.A, 5);
    const res = await setStatus(co.A, pl, 'cancelled');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(await count(`SELECT COUNT(*)::int n FROM stock_ledger WHERE reference_type='pick_list' AND reference_id=$1`, [pl.id])).toBe(0);
  });

  it('after a partial pick: returns the partial quantity, and demand nets to zero', async () => {
    const pl = await makePickList(co.A, 5);
    const before = await stockOf(co.A.item);
    await pick(co.A, pl, 3).expect(200);
    expect(await stockOf(co.A.item)).toBe(before - 3);
    const res = await setStatus(co.A, pl, 'cancelled');
    expect(res.status).toBe(200);
    expect(await stockOf(co.A.item)).toBe(before);
    expect(await netOut(pl.id)).toBe(0);
    expect(await listDemand(pl.id)).toBe(0);
    const { rows: [ret] } = await pool.query(
      `SELECT quantity_in::float qin, reason_code FROM stock_ledger
        WHERE reference_type='pick_list' AND reference_id=$1 AND quantity_in > 0`, [pl.id]);
    expect(ret).toEqual({ qin: 3, reason_code: 'pick_list_cancelled' });
  });

  it('after a completed pick that was corrected: returns the corrected quantity, not the first one', async () => {
    const pl = await makePickList(co.A, 5);
    const before = await stockOf(co.A.item);
    await pick(co.A, pl, 5).expect(200);
    await pick(co.A, pl, 4).expect(200);           // one put back
    await setStatus(co.A, pl, 'cancelled').expect(200);
    expect(await stockOf(co.A.item)).toBe(before);  // not before + 1
    expect(await netOut(pl.id)).toBe(0);
  });

  it('a repeated cancellation returns nothing a second time', async () => {
    const pl = await makePickList(co.A, 2);
    await pick(co.A, pl, 2).expect(200);
    const before = await stockOf(co.A.item);
    await setStatus(co.A, pl, 'cancelled').expect(200);
    const again = await setStatus(co.A, pl, 'cancelled');
    expect(again.status).toBe(200);
    expect(again.body.workflow.already_cancelled).toBe(true);
    expect(await stockOf(co.A.item)).toBe(before + 2);
  });

  it('two simultaneous cancellations return the stock once', async () => {
    const pl = await makePickList(co.A, 4);
    await pick(co.A, pl, 4).expect(200);
    const before = await stockOf(co.A.item);
    const [r1, r2] = await Promise.all([setStatus(co.A, pl, 'cancelled'), setStatus(co.A, pl, 'cancelled')]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(await stockOf(co.A.item)).toBe(before + 4);
    expect(await netOut(pl.id)).toBe(0);
  });

  it('a cancelled list cannot be picked again', async () => {
    const pl = await makePickList(co.A, 2);
    await setStatus(co.A, pl, 'cancelled').expect(200);
    await pick(co.A, pl, 2).expect(409);
    expect(await netOut(pl.id)).toBe(0);
  });

  it('a packed or dispatched list cannot be cancelled, and nothing moves', async () => {
    const packed = await makePickList(co.A, 2);
    await pick(co.A, packed, 2).expect(200);
    await setStatus(co.A, packed, 'packed').expect(200);
    const r1 = await setStatus(co.A, packed, 'cancelled');
    expect([r1.status, r1.body.code]).toEqual([409, 'PACKED_NOT_CANCELLABLE']);
    expect([await statusOf(packed.id), await netOut(packed.id)]).toEqual(['packed', 2]);

    const shipped = await makePickList(co.A, 2);
    await pick(co.A, shipped, 2).expect(200);
    await setStatus(co.A, shipped, 'dispatched').expect(200);
    await setStatus(co.A, shipped, 'cancelled').expect(409);
    expect([await statusOf(shipped.id), await netOut(shipped.id)]).toEqual(['dispatched', 2]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('status changes run the real workflow step', () => {
  it('"Mark packed" builds the package; packing again is a no-op', async () => {
    const pl = await makePickList(co.A, 3);
    await pick(co.A, pl, 3).expect(200);
    const res = await setStatus(co.A, pl, 'packed');
    expect(res.status).toBe(200);
    expect(res.body.workflow.package_no).toMatch(/^PKG-/);
    expect(await count(`SELECT COUNT(*)::int n FROM package_lines pl JOIN packages p ON p.id = pl.package_id WHERE p.pick_list_id=$1`, [pl.id])).toBe(1);
    await setStatus(co.A, pl, 'packed').expect(200);
    expect(await count(`SELECT COUNT(*)::int n FROM packages WHERE pick_list_id=$1`, [pl.id])).toBe(1);
  });

  it('PATCH dispatched creates the shipment and moves the order, like POST /dispatch', async () => {
    const so = await makeSalesOrder(co.A);
    const pl = await makePickList(co.A, 2, so);
    await pick(co.A, pl, 2).expect(200);
    await setStatus(co.A, pl, 'packed').expect(200);
    const res = await setStatus(co.A, pl, 'dispatched', '*', { courier: 'ZZ Courier' });
    expect(res.status).toBe(200);
    const { rows: [sh] } = await pool.query(`SELECT * FROM shipments WHERE pick_list_id = $1`, [pl.id]);
    expect(sh).toMatchObject({ company_id: co.A.id, sales_order_id: so, courier_partner: 'ZZ Courier' });
    expect(await count(`SELECT COUNT(*)::int n FROM packages WHERE pick_list_id=$1 AND shipment_id=$2`, [pl.id, sh.id])).toBe(1);
    expect((await pool.query(`SELECT order_status FROM sales_orders WHERE id=$1`, [so])).rows[0].order_status).toBe('dispatched');
    expect(await netOut(pl.id)).toBe(2);                                  // dispatch moved no stock
  });

  it('a failed final inspection blocks dispatch through BOTH routes, and writes nothing', async () => {
    const so = await makeSalesOrder(co.A);
    const { rows: [po] } = await pool.query(
      `INSERT INTO production_orders (production_order_no, product_name, quantity_planned, sales_order_id, company_id, status)
       VALUES ($1, 'ZZ product', 1, $2, $3, 'completed') RETURNING id`, [`${TAG}-PO-${so}`, so, co.A.id]);
    await pool.query(
      `INSERT INTO quality_tests (source_type, test_name, production_order_id, result, status)
       VALUES ('production', 'ZZ FAT', $1, 'fail', 'completed')`, [po.id]);
    const pl = await makePickList(co.A, 1, so);
    await pick(co.A, pl, 1).expect(200);
    const viaPost = await request(appAs(co.A.id)).post('/warehouse/dispatch').send({ pick_list_id: pl.id });
    const viaPatch = await setStatus(co.A, pl, 'dispatched');
    expect([viaPost.status, viaPost.body.code]).toEqual([409, 'FAT_GATE']);
    expect([viaPatch.status, viaPatch.body.code]).toEqual([409, 'FAT_GATE']);
    expect(await count(`SELECT COUNT(*)::int n FROM shipments WHERE pick_list_id=$1`, [pl.id])).toBe(0);
    expect(await statusOf(pl.id)).toBe('completed');
    expect((await pool.query(`SELECT order_status FROM sales_orders WHERE id=$1`, [so])).rows[0].order_status).toBe('confirmed');
  });

  it('every dispatched list of this company has its shipment', async () => {
    const { rows } = await pool.query(`
      SELECT pl.id FROM pick_lists pl
       WHERE pl.company_id = $1 AND pl.status = 'dispatched'
         AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.pick_list_id = pl.id)`, [co.A.id]);
    expect(rows).toEqual([]);
  });

  it('refuses illegal transitions with a 4xx and changes nothing', async () => {
    const pending = await makePickList(co.A, 2);
    await setStatus(co.A, pending, 'dispatched').expect(409);            // nothing picked
    await setStatus(co.A, pending, 'packed').expect(409);
    await setStatus(co.A, pending, 'completed').expect(400);             // not a settable status
    expect(await statusOf(pending.id)).toBe('pending');
    expect(await count(`SELECT COUNT(*)::int n FROM shipments WHERE pick_list_id=$1`, [pending.id])).toBe(0);
    expect(await count(`SELECT COUNT(*)::int n FROM packages WHERE pick_list_id=$1`, [pending.id])).toBe(0);

    const packed = await makePickList(co.A, 2);
    await pick(co.A, packed, 2).expect(200);
    await setStatus(co.A, packed, 'packed').expect(200);
    await pick(co.A, packed, 1).expect(409);                             // picks are frozen once packed
    expect(await netOut(packed.id)).toBe(2);
  });

  it('malformed ids are a 400, missing ones a 404', async () => {
    await request(appAs(co.A.id)).patch('/warehouse/pick-lists/abc/status').send({ status: 'cancelled' }).expect(400);
    await request(appAs(co.A.id)).patch('/warehouse/pick-lists/999999999/status').send({ status: 'cancelled' }).expect(404);
    await request(appAs(co.A.id)).post('/warehouse/dispatch').send({ pick_list_id: 999999999 }).expect(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('invoicing', () => {
  it('warehouse pick -> pack -> dispatch -> sales-order invoice never moves the stock again', async () => {
    // The order line names the picked item, so the shipped goods are billed
    // through their pick line (Phase 3F). This suite's opening stock predates
    // FIFO layering, so their cost cannot be verified and the invoice is
    // refused — with the stock moved exactly once, by the pick. The priced,
    // costed path is proved in integration.salesInvoicingPhase3F.test.js.
    const so = await makeSalesOrder(co.A);
    await pool.query(`UPDATE sales_order_items SET item_id = $2 WHERE order_id = $1`, [so, co.A.item]);
    const pl = await makePickList(co.A, 5, so);
    const before = await stockOf(co.A.item);
    await pick(co.A, pl, 5).expect(200);
    await setStatus(co.A, pl, 'packed').expect(200);
    await request(appAs(co.A.id)).post('/warehouse/dispatch').send({ pick_list_id: pl.id }).expect(200);
    const inv = await request(appAs(co.A.id)).patch(`/sales/orders/${so}/invoice`).send({});
    expect([inv.status, inv.body.code]).toEqual([422, 'FULFILMENT_COST_UNVERIFIED']);
    expect(await stockOf(co.A.item)).toBe(before - 5);
    expect(await count(`SELECT COUNT(*)::int n FROM invoices WHERE sales_order_id=$1`, [so])).toBe(0);
    expect((await pool.query(`SELECT order_status, invoice_id FROM sales_orders WHERE id=$1`, [so])).rows[0])
      .toEqual({ order_status: 'dispatched', invoice_id: null });
  });

  it('a sales order is invoiced once — a retry is refused', async () => {
    const so = await makeSalesOrder(co.A);
    await request(appAs(co.A.id)).patch(`/sales/orders/${so}/invoice`).send({}).expect(200);
    const again = await request(appAs(co.A.id)).patch(`/sales/orders/${so}/invoice`).send({});
    expect([again.status, again.body.code]).toEqual([409, 'ALREADY_INVOICED']);
    expect(await count(`SELECT COUNT(*)::int n FROM invoices WHERE sales_order_id=$1`, [so])).toBe(1);
  });

  it('two simultaneous invoice requests for one order raise one invoice', async () => {
    const so = await makeSalesOrder(co.A);
    const [r1, r2] = await Promise.all([
      request(appAs(co.A.id)).patch(`/sales/orders/${so}/invoice`).send({}),
      request(appAs(co.A.id)).patch(`/sales/orders/${so}/invoice`).send({}),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await count(`SELECT COUNT(*)::int n FROM invoices WHERE sales_order_id=$1`, [so])).toBe(1);
    expect(await count(`SELECT COUNT(*)::int n FROM journal_entries WHERE reference_type='invoice'
                          AND reference_id::text IN (SELECT id::text FROM invoices WHERE sales_order_id=$1)`, [so])).toBe(1);
  });

  it('a cancelled order cannot be invoiced', async () => {
    const so = await makeSalesOrder(co.A, 'cancelled');
    await request(appAs(co.A.id)).patch(`/sales/orders/${so}/invoice`).send({}).expect(409);
    expect(await count(`SELECT COUNT(*)::int n FROM invoices WHERE sales_order_id=$1`, [so])).toBe(0);
  });

  it('an invoice line carrying item_id is refused before anything is written', async () => {
    const before = {
      stock: await stockOf(co.A.item),
      invoices: await count(`SELECT COUNT(*)::int n FROM invoices WHERE company_id=$1`, [co.A.id]),
      journals: await count(`SELECT COUNT(*)::int n FROM journal_entries WHERE company_id=$1`, [co.A.id]),
    };
    const res = await request(appAs(co.A.id)).post('/finance/invoices').send({
      invoice_date: '2026-10-22', due_date: '2026-11-21', subtotal: 300, tax_amount: 0, total_amount: 300,
      items: [{ item_id: co.A.item, description: 'goods', quantity: 3, unit_price: 100, unit_cost: 100, amount: 300 }],
    });
    expect([res.status, res.body.code]).toEqual([422, 'STOCK_LINE_REQUIRES_FULFILMENT']);
    expect({
      stock: await stockOf(co.A.item),
      invoices: await count(`SELECT COUNT(*)::int n FROM invoices WHERE company_id=$1`, [co.A.id]),
      journals: await count(`SELECT COUNT(*)::int n FROM journal_entries WHERE company_id=$1`, [co.A.id]),
    }).toEqual(before);
  });

  it('an invoice cannot be cancelled or paid by editing it; working edits still save', async () => {
    const inv = await invoiceService.createInvoice({
      invoice_date: '2026-10-22', due_date: '2026-11-21', subtotal: 100, tax_amount: 0, total_amount: 100,
      company_id: co.A.id, items: [{ description: 'service', quantity: 1, unit_price: 100, amount: 100 }],
    }, null);
    for (const status of ['cancelled', 'paid', 'void']) {
      const res = await request(appAs(co.A.id)).put(`/finance/invoices/${inv.id}`).send({ status });
      expect([status, res.status, res.body.code]).toEqual([status, 409, 'INVOICE_STATUS_NOT_EDITABLE']);
    }
    expect((await pool.query(`SELECT status FROM invoices WHERE id=$1`, [inv.id])).rows[0].status).toBe('sent');
    await request(appAs(co.A.id)).put(`/finance/invoices/${inv.id}`).send({ status: 'draft', notes: 'edited' }).expect(200);
    expect((await pool.query(`SELECT status FROM invoices WHERE id=$1`, [inv.id])).rows[0].status).toBe('draft');
    // Another company cannot edit it at all.
    await request(appAs(co.B.id)).put(`/finance/invoices/${inv.id}`).send({ notes: 'hijack' }).expect(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('tenancy and permissions', () => {
  it('sales orders: invoice, cancel, dispatch and deliver are refused across companies; B can act on its own', async () => {
    const soB = await makeSalesOrder(co.B);
    const snap = async () => (await pool.query(
      `SELECT order_status, invoice_id, cancel_reason, carrier FROM sales_orders WHERE id=$1`, [soB])).rows[0];
    const before = await snap();
    const asA = appAs(co.A.id);
    await request(asA).patch(`/sales/orders/${soB}/invoice`).send({}).expect(404);
    await request(asA).patch(`/sales/orders/${soB}/cancel`).send({ reason: 'hijack' }).expect(404);
    await request(asA).put(`/sales/orders/${soB}/dispatch`).send({ carrier: 'X', force: true }).expect(404);
    await request(asA).put(`/sales/orders/${soB}/deliver`).send({}).expect(404);
    expect(await snap()).toEqual(before);
    expect(await count(`SELECT COUNT(*)::int n FROM invoices WHERE sales_order_id=$1`, [soB])).toBe(0);
    // Positive pair.
    await request(appAs(co.B.id)).patch(`/sales/orders/${soB}/cancel`).send({ reason: 'own' }).expect(200);
    expect((await snap()).order_status).toBe('cancelled');
  });

  it('pick lists: company A cannot pick, pack, dispatch or cancel B\'s list', async () => {
    const plB = await makePickList(co.B, 3);
    await pick(co.B, plB, 3).expect(200);
    const asA = appAs(co.A.id);
    await request(asA).put(`/warehouse/pick-lists/${plB.id}/pick`)
      .send({ lines: [{ line_id: plB.lineId, picked_qty: 1 }] }).expect(404);
    await request(asA).post('/warehouse/pack').send({ pick_list_id: plB.id }).expect(404);
    await request(asA).post('/warehouse/dispatch').send({ pick_list_id: plB.id }).expect(404);
    await request(asA).patch(`/warehouse/pick-lists/${plB.id}/status`).send({ status: 'cancelled' }).expect(404);
    expect([await statusOf(plB.id), await netOut(plB.id)]).toEqual(['completed', 3]);
  });

  it('a pick list cannot be created against another company\'s order, item or bin', async () => {
    const soB = await makeSalesOrder(co.B);
    const before = await count(`SELECT COUNT(*)::int n FROM pick_lists WHERE company_id=$1`, [co.A.id]);
    const line = { item_id: co.A.item, item_name: 'x', bin_location_id: co.A.bin, required_qty: 1 };
    const asA = appAs(co.A.id);
    await request(asA).post('/warehouse/pick-lists').send({ sales_order_id: soB, lines: [line] }).expect(404);
    await request(asA).post('/warehouse/pick-lists').send({ lines: [{ ...line, item_id: co.B.item }] }).expect(404);
    await request(asA).post('/warehouse/pick-lists').send({ lines: [{ ...line, bin_location_id: co.B.bin }] }).expect(404);
    expect(await count(`SELECT COUNT(*)::int n FROM pick_lists WHERE company_id=$1`, [co.A.id])).toBe(before);
  });

  it('view-only callers are refused every write', async () => {
    const pl = await makePickList(co.A, 1);
    const view = ['inventory:view', 'sales:view', 'finance:view'];
    await pick(co.A, pl, 1, view).expect(403);
    await setStatus(co.A, pl, 'cancelled', view).expect(403);
    await request(appAs(co.A.id, view)).post('/warehouse/pack').send({ pick_list_id: pl.id }).expect(403);
    await request(appAs(co.A.id, view)).post('/warehouse/dispatch').send({ pick_list_id: pl.id }).expect(403);
    const so = await makeSalesOrder(co.A);
    await request(appAs(co.A.id, view)).patch(`/sales/orders/${so}/invoice`).send({}).expect(403);
    expect([await statusOf(pl.id), await netOut(pl.id)]).toEqual(['pending', 0]);
    expect(await count(`SELECT COUNT(*)::int n FROM invoices WHERE sales_order_id=$1`, [so])).toBe(0);
  });

  it('shipments: POD and route-stop delivery are refused across companies, before any file is written', async () => {
    const { rows: [shB] } = await pool.query(
      `INSERT INTO shipments (company_id, status, direction, dispatch_ref) VALUES ($1, 'in_transit', 'outbound', $2) RETURNING id`,
      [co.B.id, `${TAG}-DSP-B`]);
    const { rows: [rtB] } = await pool.query(
      `INSERT INTO delivery_routes (company_id, route_date) VALUES ($1, CURRENT_DATE) RETURNING id`, [co.B.id]);
    const { rows: [stB] } = await pool.query(
      `INSERT INTO route_stops (route_id, stop_seq, shipment_id) VALUES ($1, 1, $2) RETURNING id`, [rtB.id, shB.id]);
    uploadFile.mockClear();
    const asA = appAs(co.A.id);
    await request(asA).post(`/logistics/shipments/${shB.id}/pod`).send({ pod_image_base64: 'aGVsbG8=' }).expect(404);
    expect(uploadFile).not.toHaveBeenCalled();
    await request(asA).patch(`/scm/routes/${rtB.id}/stops/${stB.id}`).send({ status: 'delivered' }).expect(404);
    expect((await pool.query(`SELECT status FROM shipments WHERE id=$1`, [shB.id])).rows[0].status).toBe('in_transit');
    // Positive pair: B records its own POD.
    await request(appAs(co.B.id)).post(`/logistics/shipments/${shB.id}/pod`).send({ pod_image_base64: 'aGVsbG8=' }).expect(200);
    expect((await pool.query(`SELECT status FROM shipments WHERE id=$1`, [shB.id])).rows[0].status).toBe('delivered');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('historical pick-list diagnostic (read-only)', () => {
  const lists = {};
  /** A list as the OLD code could have left it: lines and ledger rows written directly. */
  async function legacyList(name, { status = 'completed', lines, ledger }) {
    const { rows: [pl] } = await pool.query(
      `INSERT INTO pick_lists (company_id, status, notes) VALUES ($1, $2, $3) RETURNING id`, [co.A.id, status, `${TAG} ${name}`]);
    for (const l of lines) {
      await pool.query(
        `INSERT INTO pick_list_lines (pick_list_id, item_id, item_name, bin_location_id, required_qty, picked_qty, status)
         VALUES ($1, $2, 'legacy', $3, $4, $4, 'completed')`, [pl.id, l.item ?? co.A.item, l.bin === undefined ? co.A.bin : l.bin, l.qty]);
    }
    for (const r of ledger) {
      await pool.query(
        `INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, quantity_in, quantity_out, rate,
                                   reference_type, reference_id, transaction_date, company_id, remarks)
         VALUES ($1, $2, $3, $4, $5, 100, 'pick_list', $6, CURRENT_DATE - 10, $7, $8)`,
        [r.item ?? co.A.item, r.wh === undefined ? co.A.wh : r.wh, r.type ?? 'dispatch', r.in ?? 0, r.out ?? 0,
         pl.id, co.A.id, `${TAG} legacy`]);
    }
    lists[name] = pl.id;
  }

  let report, snapshot;
  // Scoped to this suite's company: other suites write the shared ledger in
  // parallel, so a database-wide count would move for reasons unrelated to the
  // diagnostic.
  const snap = async () => (await pool.query(`
    SELECT (SELECT COUNT(*) FROM stock_ledger WHERE company_id = $1)::int AS ledger,
           (SELECT COALESCE(SUM(quantity_in - quantity_out), 0) FROM stock_ledger WHERE company_id = $1)::float AS balance,
           (SELECT COUNT(*) FROM pick_lists WHERE company_id = $1)::int AS lists,
           (SELECT md5(string_agg(l.id || ':' || COALESCE(l.picked_qty, 0), ',' ORDER BY l.id))
              FROM pick_list_lines l JOIN pick_lists p ON p.id = l.pick_list_id WHERE p.company_id = $1) AS lines,
           (SELECT md5(string_agg(id || ':' || status, ',' ORDER BY id)) FROM pick_lists WHERE company_id = $1) AS statuses`,
    [co.A.id])).rows[0];

  beforeAll(async () => {
    await legacyList('CORRECT',   { lines: [{ qty: 5 }], ledger: [{ out: 5 }] });
    await legacyList('OVER',      { lines: [{ qty: 4 }], ledger: [{ out: 4 }, { out: 4 }] });            // saved twice
    await legacyList('CORRECTED', { lines: [{ qty: 5 }], ledger: [{ out: 3 }, { out: 5 }, { in: 3 }] }); // fixed later
    await legacyList('CANCELLED', { status: 'cancelled', lines: [{ qty: 2 }], ledger: [{ out: 2 }] });
    await legacyList('TWOLINES',  { lines: [{ qty: 2 }, { qty: 3 }], ledger: [{ out: 5 }] });          // same item & warehouse
    await legacyList('NOBIN',     { lines: [{ qty: 3, bin: null }], ledger: [{ out: 3 }] });
    await legacyList('ODDTYPE',   { lines: [{ qty: 1 }], ledger: [{ out: 1, type: 'issue' }] });
    snapshot = await snap();
    report = await diagnosePickListPostings(pool, co.A.id, { includeOk: true });
  }, 60_000);

  const rowOf = (name) => report.rows.filter(r => r.pick_list_id === lists[name]);

  it('agrees with a correct list, and counts two lines of one item once', () => {
    expect(rowOf('CORRECT').map(r => r.classification)).toEqual(['ok']);
    expect(rowOf('TWOLINES')).toHaveLength(1);
    expect(rowOf('TWOLINES')[0]).toMatchObject({ picked_qty: 5, posted_out: 5, classification: 'ok' });
  });

  it('finds the over-posted list and the size of the excess', () => {
    expect(rowOf('OVER')[0]).toMatchObject({ picked_qty: 4, posted_out: 8, difference: 4, classification: 'over_posted' });
  });

  it('accepts a list a later correction already repaired, and says so', () => {
    expect(rowOf('CORRECTED')[0]).toMatchObject({ posted_out: 5, classification: 'ok', has_prior_corrections: true });
  });

  it('finds a list cancelled with its stock never returned', () => {
    expect(rowOf('CANCELLED')[0]).toMatchObject({ expected_out: 0, posted_out: 2, difference: 2, classification: 'cancelled_not_restored' });
  });

  it('refuses to judge what it cannot resolve', () => {
    expect(rowOf('NOBIN').map(r => r.classification)).toContain('ambiguous');
    expect(rowOf('ODDTYPE')[0].classification).toBe('ambiguous');
    expect(rowOf('ODDTYPE')[0].reasons.join(' ')).toMatch(/type other than 'dispatch'/);
  });

  it('is scoped to the company asked about', async () => {
    const forB = await diagnosePickListPostings(pool, co.B.id, { includeOk: true });
    const ours = new Set(Object.values(lists));
    expect(forB.rows.some(r => ours.has(r.pick_list_id))).toBe(false);
  });

  it('writes nothing — before and after are identical, and the route agrees', async () => {
    const res = await request(appAs(co.A.id, ['inventory:view'])).get('/warehouse/pick-lists/stock-reconciliation');
    expect(res.status).toBe(200);
    expect(res.body.read_only).toBe(true);
    expect(res.body.summary.over_posted).toBeGreaterThanOrEqual(1);
    expect(await snap()).toEqual(snapshot);
  });
});
