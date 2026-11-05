/**
 * integration.salesDispatchDuplication.test.js — can one sale leave the stock
 * ledger twice? Against the REAL database, through the REAL routers.
 *
 * THE TWO WRITERS (traced 2026-10-22)
 *
 *   'dispatch'        PUT /warehouse/pick-lists/:id/pick — the warehouse
 *                     fulfilment flow (pick -> pack -> dispatch). Stock leaves at
 *                     PICK; POST /warehouse/dispatch writes the shipment and moves
 *                     no stock. reference_type 'pick_list', reference_id = list.
 *   'sales_dispatch'  cogsJournal.createForInvoice, called by
 *                     invoiceService.createInvoice for every invoice line that
 *                     carries item_id + unit_cost. reference_type 'invoice'.
 *
 * WHAT WAS FOUND
 *
 *   - Sales-order invoicing (PATCH /sales/orders/:id/invoice) and every other
 *     internal invoice caller send lines WITHOUT item_id, so invoicing a picked
 *     order does not move stock a second time. Asserted below.
 *   - A stock-carrying invoice can only come from an external client of
 *     POST /finance/invoices. invoice_items stores no item_id and that path
 *     sets no sales order, so nothing in the schema links such an invoice to a
 *     pick list — the two cannot be reconciled from data, and no fix is
 *     attempted for that case (reported instead).
 *   - The CONFIRMED duplicate was inside the warehouse flow itself: the pick
 *     route posted the full picked quantity on EVERY call while storing
 *     picked_qty as an absolute value. A retried request, a double click, or a
 *     partial pick completed later (3 then 5) deducted 3 + 5 = 8 for 5 picked —
 *     double stock-out and double demand. It also updated pick_list_lines by id
 *     alone, from any pick list in any company.
 *
 * The fix reconciles the ledger to the pick list rather than posting each
 * request: per item and warehouse, picked quantity minus what this pick list
 * has already posted. Retries post nothing, corrections post the difference
 * (a reduction posts the ISSUE type with quantity_in — a reversal under
 * ledgerSemantics), and the pick list row lock serialises concurrent requests.
 *
 * Self-cleaning: two companies tagged ZZSDUP, swept on the way in and out.
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
    // The sales router authenticates at router level; the test caller is
    // already established by appAs(), so a present user is an authenticated one.
    verifyToken: (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Unauthorized' })),
    requirePermission: (module, action) => (req, res, next) =>
      (allows(req, `${module}:${action}`) ? next() : res.status(403).json({ error: 'Forbidden' })),
  };
});

const { default: pool }            = await import('../config/db.js');
const { default: warehouseRouter } = await import('../modules/warehouse/warehouse.routes.js');
const { default: inventoryRouter } = await import('../modules/inventory/routes/inventory.routes.js');
const { default: salesRouter }     = await import('../modules/sales/routes/sales.routes.js');
const { default: invoiceService }  = await import('../modules/finance/services/invoice.service.js');
const semantics                    = await import('../modules/inventory/services/ledgerSemantics.js');

const TAG = 'ZZSDUP';

function appAs(companyId, perms = '*') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId: 1, id: 1, roles: ['admin'], company_id: companyId, perms };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/warehouse', warehouseRouter);
  app.use('/inventory', inventoryRouter);
  app.use('/sales', salesRouter);
  return app;
}

const co = {};          // 'A' | 'B' -> { id, wh, zone, bin, item }

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  const items = `(SELECT id FROM inventory_items WHERE company_id = ANY($1))`;
  const del = async (sql) => { try { await pool.query(sql, [ids]); } catch { /* order — later passes */ } };
  for (let pass = 0; pass < 2; pass++) {
    await del(`DELETE FROM inventory_fifo_consumption WHERE item_id IN ${items}`);
    await del(`DELETE FROM inventory_fifo_layers WHERE item_id IN ${items}`);
    await del(`DELETE FROM stock_ledger WHERE item_id IN ${items}`);
    await del(`DELETE FROM shipments WHERE company_id = ANY($1)`);
    await del(`DELETE FROM package_lines WHERE company_id = ANY($1)`);
    await del(`DELETE FROM packages WHERE company_id = ANY($1)`);
    await del(`DELETE FROM pick_list_lines WHERE pick_list_id IN (SELECT id FROM pick_lists WHERE company_id = ANY($1))`);
    await del(`DELETE FROM pick_lists WHERE company_id = ANY($1)`);
    await del(`DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id = ANY($1))`);
    await del(`DELETE FROM journal_entries WHERE company_id = ANY($1)`);
    await del(`DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id = ANY($1))`);
    await del(`DELETE FROM invoices WHERE company_id = ANY($1)`);
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
  const id = (await pool.query(`INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`,
    [`${TAG} Co ${s}`, `${TAG}${s}`])).rows[0].id;
  const wh = (await pool.query(
    `INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ($1, $1, $2) RETURNING id`,
    [`${TAG} WH ${s}`, id])).rows[0].id;
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
     VALUES ($1, $2, 'opening', 100, 0, 100, CURRENT_DATE - 30, $3, $4)`, [item, wh, id, `${TAG} opening`]);
  // Its FIFO cost layer, so goods picked from it have a verifiable cost and
  // can be invoiced through their pick line (Phase 3F).
  await pool.query(
    `INSERT INTO inventory_fifo_layers (company_id, item_id, warehouse_id, received_date, qty_received, qty_remaining, unit_cost, source_type)
     VALUES ($1, $2, $3, CURRENT_DATE - 30, 100, 100, 100, 'opening')`, [id, item, wh]);
  co[s] = { id, wh, zone, bin, item };
}

let soSeq = 0;
async function makeSalesOrder(c) {
  soSeq++;
  const so = (await pool.query(
    `INSERT INTO sales_orders (order_number, company_id, customer_name, order_status, subtotal, tax_amount, total_amount)
     VALUES ($1, $2, 'ZZ Customer', 'confirmed', 500, 0, 500) RETURNING id`,
    [`${TAG}-SO-${c.id}-${soSeq}`, c.id])).rows[0].id;
  await pool.query(
    `INSERT INTO sales_order_items (order_id, item_id, item_code, description, quantity, unit_price, tax_rate, total_amount)
     VALUES ($1, $3, $2, 'ZZ goods', 5, 100, 0, 500)`, [so, `${TAG}-ITEM`, c.item]);
  return so;
}
async function makePickList(c, requiredQty = 5, salesOrderId = null) {
  const res = await request(appAs(c.id)).post('/warehouse/pick-lists').send({
    sales_order_id: salesOrderId, sales_order_ref: salesOrderId ? `SO-${salesOrderId}` : null,
    lines: [{ item_id: c.item, item_name: `${TAG} Item`, bin_location_id: c.bin, bin_code: 'B', required_qty: requiredQty }],
  });
  expect(res.status).toBe(201);
  const { rows: [line] } = await pool.query(`SELECT id FROM pick_list_lines WHERE pick_list_id = $1`, [res.body.id]);
  return { id: res.body.id, lineId: line.id };
}
const pick = (c, pl, qty, perms = '*') => request(appAs(c.id, perms)).put(`/warehouse/pick-lists/${pl.id}/pick`)
  .send({ lines: [{ line_id: pl.lineId, picked_qty: qty, bin_location_id: c.bin, item_id: c.item, item_name: `${TAG} Item` }] });

/** What the ledger says left (net) for an item, by transaction type and reference. */
async function outflow(itemId, where = '') {
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(SUM(quantity_out - quantity_in), 0)::float AS net FROM stock_ledger
      WHERE item_id = $1 AND LOWER(transaction_type) <> 'opening' ${where}`, [itemId]);
  return r.net;
}
async function demandOf(itemId) {
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(SUM(${semantics.demandQtySql()}), 0)::float AS d FROM stock_ledger WHERE item_id = $1`, [itemId]);
  return r.d;
}
const stockOf = async (itemId) => Number((await pool.query(
  `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS q FROM stock_ledger WHERE item_id = $1`, [itemId])).rows[0].q);

beforeAll(async () => {
  await sweep();
  await makeCompany('A');
  await makeCompany('B');
}, 60_000);
afterAll(async () => { await sweep(); }, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
describe('a legitimate standalone issue', () => {
  it('posts once and counts once', async () => {
    const before = await stockOf(co.A.item);
    const res = await request(appAs(co.A.id)).post('/inventory/stock/movement')
      .send({ item_id: co.A.item, warehouse_id: co.A.wh, movement_type: 'OUT', quantity: 2, notes: TAG });
    expect(res.status).toBeLessThan(300);
    expect(await stockOf(co.A.item)).toBe(before - 2);
    expect(await outflow(co.A.item, `AND reference_type = 'manual'`)).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a sale fulfilled by the warehouse: pick -> pack -> dispatch -> invoice', () => {
  let pl, so;
  beforeAll(async () => {
    so = await makeSalesOrder(co.A);
    pl = await makePickList(co.A, 5, so);
  });

  it('deducts stock once, at pick', async () => {
    const res = await pick(co.A, pl, 5);
    expect(res.status).toBe(200);
    expect(await outflow(co.A.item, `AND reference_type = 'pick_list' AND reference_id = ${pl.id}`)).toBe(5);
  });

  it('packing and dispatching move no further stock', async () => {
    await request(appAs(co.A.id)).post('/warehouse/pack').send({ pick_list_id: pl.id }).expect(201);
    const res = await request(appAs(co.A.id)).post('/warehouse/dispatch').send({ pick_list_id: pl.id });
    expect(res.status).toBe(200);
    expect(await outflow(co.A.item, `AND reference_type = 'pick_list' AND reference_id = ${pl.id}`)).toBe(5);
  });

  it('invoicing the same sales order posts no second stock-out (no sales_dispatch)', async () => {
    const res = await request(appAs(co.A.id)).patch(`/sales/orders/${so}/invoice`).send({});
    expect(res.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM stock_ledger WHERE item_id = $1 AND LOWER(transaction_type) = 'sales_dispatch'`,
      [co.A.item]);
    expect(rows[0].n).toBe(0);
    expect(await outflow(co.A.item, `AND reference_type IN ('pick_list', 'invoice')`)).toBe(5);
  });

  it('a pick list cannot be re-picked once dispatched', async () => {
    const res = await pick(co.A, pl, 9);
    expect(res.status).toBe(409);
    expect(await outflow(co.A.item, `AND reference_type = 'pick_list' AND reference_id = ${pl.id}`)).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('retries, partial picks and corrections (the confirmed duplicate)', () => {
  it('a retried pick request posts nothing the second time', async () => {
    const pl = await makePickList(co.A, 4);
    expect((await pick(co.A, pl, 4)).status).toBe(200);
    expect((await pick(co.A, pl, 4)).status).toBe(200);           // double click / network retry
    const where = `AND reference_type = 'pick_list' AND reference_id = ${pl.id}`;
    expect(await outflow(co.A.item, where)).toBe(4);
    const { rows: [n] } = await pool.query(
      `SELECT COUNT(*)::int n FROM stock_ledger WHERE item_id = $1 ${where}`, [co.A.item]);
    expect(n.n).toBe(1);
  });

  it('a partial pick completed later deducts the total picked, not the sum of requests', async () => {
    const pl = await makePickList(co.A, 5);
    await pick(co.A, pl, 3).expect(200);
    await pick(co.A, pl, 5).expect(200);                          // was 3 + 5 = 8
    expect(await outflow(co.A.item, `AND reference_type = 'pick_list' AND reference_id = ${pl.id}`)).toBe(5);
  });

  it('a downward correction returns the difference, and demand follows', async () => {
    const pl = await makePickList(co.A, 5);
    const before = await demandOf(co.A.item);
    await pick(co.A, pl, 5).expect(200);
    await pick(co.A, pl, 2).expect(200);                          // over-picked; 3 back to the bin
    const where = `AND reference_type = 'pick_list' AND reference_id = ${pl.id}`;
    expect(await outflow(co.A.item, where)).toBe(2);
    expect(await demandOf(co.A.item) - before).toBe(2);
    const { rows: [rev] } = await pool.query(
      `SELECT transaction_type, quantity_in::float AS qin FROM stock_ledger WHERE item_id = $1 ${where} AND quantity_in > 0`,
      [co.A.item]);
    expect(semantics.classifyLedgerRow(rev.transaction_type, rev.qin, 0)).toBe('issue_reversal');
  });

  it('two simultaneous identical pick requests deduct once', async () => {
    const pl = await makePickList(co.A, 6);
    const [r1, r2] = await Promise.all([pick(co.A, pl, 6), pick(co.A, pl, 6)]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(await outflow(co.A.item, `AND reference_type = 'pick_list' AND reference_id = ${pl.id}`)).toBe(6);
  });

  it('refuses a negative picked quantity', async () => {
    const pl = await makePickList(co.A, 2);
    expect((await pick(co.A, pl, -1)).status).toBe(400);
    expect(await outflow(co.A.item, `AND reference_type = 'pick_list' AND reference_id = ${pl.id}`)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cancellation, tenancy and permissions', () => {
  it('a cancelled pick list cannot be picked', async () => {
    const pl = await makePickList(co.A, 2);
    await request(appAs(co.A.id)).patch(`/warehouse/pick-lists/${pl.id}/status`).send({ status: 'cancelled' }).expect(200);
    expect((await pick(co.A, pl, 2)).status).toBe(409);
    expect(await outflow(co.A.item, `AND reference_type = 'pick_list' AND reference_id = ${pl.id}`)).toBe(0);
  });

  it("company A cannot pick, or re-status, company B's pick list", async () => {
    const plB = await makePickList(co.B, 3);
    const before = await stockOf(co.B.item);
    const res = await request(appAs(co.A.id)).put(`/warehouse/pick-lists/${plB.id}/pick`)
      .send({ lines: [{ line_id: plB.lineId, picked_qty: 3, bin_location_id: co.B.bin, item_id: co.B.item }] });
    expect(res.status).toBe(404);
    await request(appAs(co.A.id)).patch(`/warehouse/pick-lists/${plB.id}/status`).send({ status: 'cancelled' }).expect(404);
    expect(await stockOf(co.B.item)).toBe(before);
    const { rows: [l] } = await pool.query(`SELECT picked_qty FROM pick_list_lines WHERE id = $1`, [plB.lineId]);
    expect(Number(l.picked_qty || 0)).toBe(0);
    const { rows: [p] } = await pool.query(`SELECT status FROM pick_lists WHERE id = $1`, [plB.id]);
    expect(p.status).not.toBe('cancelled');
    // Positive pair: B can pick its own list.
    await pick(co.B, plB, 3).expect(200);
    expect(await stockOf(co.B.item)).toBe(before - 3);
  });

  it("a line from another pick list cannot be smuggled into this one", async () => {
    const mine = await makePickList(co.A, 2);
    const other = await makePickList(co.A, 2);
    const res = await request(appAs(co.A.id)).put(`/warehouse/pick-lists/${mine.id}/pick`)
      .send({ lines: [{ line_id: other.lineId, picked_qty: 2, bin_location_id: co.A.bin, item_id: co.A.item }] });
    expect(res.status).toBe(404);
    expect(await outflow(co.A.item, `AND reference_type = 'pick_list' AND reference_id IN (${mine.id}, ${other.id})`)).toBe(0);
  });

  it('picking needs inventory:edit', async () => {
    const pl = await makePickList(co.A, 1);
    expect((await pick(co.A, pl, 1, ['inventory:view'])).status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the separate invoice-posting path (API clients only)', () => {
  // Phase 3C: because nothing links such an invoice to the pick (next test),
  // a stock-carrying invoice line is now refused rather than posting a
  // sales_dispatch that might duplicate a warehouse pick.
  it('a stock-carrying invoice is refused, and moves no stock', async () => {
    const before = await stockOf(co.A.item);
    await expect(invoiceService.createInvoice({
      invoice_date: new Date().toISOString().slice(0, 10), due_date: new Date().toISOString().slice(0, 10),
      subtotal: 300, tax_amount: 0, total_amount: 300, company_id: co.A.id,
      items: [{ item_id: co.A.item, description: 'ZZ direct sale', quantity: 3, unit_price: 100, unit_cost: 100, amount: 300 }],
    }, null)).rejects.toMatchObject({ status: 422, code: 'STOCK_LINE_REQUIRES_FULFILMENT' });
    expect(await stockOf(co.A.item)).toBe(before);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM stock_ledger WHERE item_id = $1 AND LOWER(transaction_type) = 'sales_dispatch'`,
      [co.A.item]);
    expect(rows[0].n).toBe(0);
  });

  // Phase 3E closed the gap this tripwire guarded: an invoice line can now name
  // the shipped pick-list line it bills (migration 20261027000003), and the
  // database itself guards that link. Coverage of the contract is in
  // integration.invoiceFulfilment.test.js.
  it('an invoice line can name the pick-list line it bills, behind a database guard', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'invoice_items' AND column_name IN ('item_id', 'pick_list_line_id', 'unit_cost') ORDER BY 1`);
    expect(rows.map(r => r.column_name)).toEqual(['item_id', 'pick_list_line_id', 'unit_cost']);
    const { rows: trg } = await pool.query(
      `SELECT 1 FROM pg_trigger WHERE tgname = 'trg_invoice_items_fulfilment_guard'`);
    expect(trg).toHaveLength(1);
  });
});
