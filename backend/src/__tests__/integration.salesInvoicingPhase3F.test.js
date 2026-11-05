/**
 * integration.salesInvoicingPhase3F.test.js — sales-order invoicing through the
 * fulfilment link, and credit notes that release invoiced quantity. Against the
 * REAL database, through the REAL routers.
 *
 * WHAT IS PROVED (Phase 3F, priority 1)
 *   - PATCH /sales/orders/:id/invoice bills only goods that left stock on the
 *     order's dispatched pick lists, linked to the pick line, priced from the
 *     order line, COGS at the pick's FIFO cost; never moves stock. Partial
 *     invoicing across dispatches; fully invoiced → 'invoiced'. Lines without
 *     an item are billed once. An older whole-order invoice, nothing shipped,
 *     a pick line not on the order, another company's order — all refused with
 *     nothing written. Concurrent requests (sales-order and direct invoicing)
 *     never bill a pick line beyond what shipped.
 *   - Atomic: a failure after the invoice row, its lines and its revenue
 *     journal were written (COGS refused for a zero cost) leaves none of them,
 *     and the order untouched.
 *   - Credit notes: a draft releases nothing; issuing posts a balanced journal
 *     (it used to fail on MAX(uuid)) and releases the credited quantity, once,
 *     also under concurrent issue; re-invoicing a released quantity bills it
 *     again with NO second COGS; credits beyond what a line billed, lines of
 *     another invoice and another company's invoice are refused; cancelling a
 *     note whose release has been re-invoiced is refused, otherwise it takes
 *     the release back; every write is scoped to the caller's company.
 *
 * Permission gates are stubbed to grant exactly the caller's permissions;
 * tenant scope is the routes' own. Cleanup deletes only this suite's companies.
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

const { default: pool }              = await import('../config/db.js');
const { default: warehouseRouter }   = await import('../modules/warehouse/warehouse.routes.js');
const { default: salesRouter }       = await import('../modules/sales/routes/sales.routes.js');
const { default: financeRouter }     = await import('../modules/finance/routes/finance.routes.js');
const { default: creditNotesRouter } = await import('../modules/finance/creditNotes.routes.js');
const { postStock }                  = await import('../modules/production/subcontracting.routes.js');

const TAG = 'ZZP3F';

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
  app.use('/finance/credit-notes', creditNotesRouter);
  app.use('/finance', financeRouter);
  return app;
}

const co = {};
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
const num = async (sql, params = []) => Number(Object.values((await pool.query(sql, params)).rows[0])[0]);

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  const items = `(SELECT id FROM inventory_items WHERE company_id = ANY($1))`;
  const steps = [
    `DELETE FROM credit_note_items WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE company_id = ANY($1))`,
    `DELETE FROM credit_notes WHERE company_id = ANY($1)`,
    `DELETE FROM inventory_fifo_consumption WHERE item_id IN ${items}`,
    `DELETE FROM inventory_fifo_layers WHERE item_id IN ${items}`,
    `DELETE FROM stock_ledger WHERE item_id IN ${items}`,
    `DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id = ANY($1))`,
    `UPDATE sales_orders SET invoice_id = NULL WHERE company_id = ANY($1)`,
    `DELETE FROM invoices WHERE company_id = ANY($1)`,
    `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE company_id = ANY($1))`,
    `DELETE FROM journal_entries WHERE company_id = ANY($1)`,
    `DELETE FROM package_lines WHERE company_id = ANY($1)`,
    `DELETE FROM packages WHERE company_id = ANY($1)`,
    `DELETE FROM shipments WHERE company_id = ANY($1)`,
    `DELETE FROM pick_list_lines WHERE pick_list_id IN (SELECT id FROM pick_lists WHERE company_id = ANY($1))`,
    `DELETE FROM pick_lists WHERE company_id = ANY($1)`,
    `DELETE FROM sales_order_items WHERE order_id IN (SELECT id FROM sales_orders WHERE company_id = ANY($1))`,
    `DELETE FROM sales_orders WHERE company_id = ANY($1)`,
    `DELETE FROM audit_logs WHERE company_id = ANY($1)`,
    `DELETE FROM inventory_items WHERE company_id = ANY($1)`,
    `DELETE FROM warehouse_bins WHERE company_id = ANY($1)`,
    `DELETE FROM warehouse_zones WHERE warehouse_id IN (SELECT id FROM warehouses WHERE company_id = ANY($1))`,
    `DELETE FROM warehouses WHERE company_id = ANY($1)`,
  ];
  for (const sql of steps) { try { await pool.query(sql, [ids]); } catch { /* table absent or order — fallback below */ } }
  try {
    await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [ids]);
  } catch {
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

let seq = 0;
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
  co[s] = { id, wh, zone, bin };
}
/** A fresh item with FIFO layers [qty, unit_cost], opened through postStock. */
async function makeItem(c, layers = [[6, 80], [200, 120]]) {
  seq++;
  const item = (await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, standard_cost)
     VALUES ($1, $2, $3, 'NOS', 100) RETURNING id`, [`${TAG}-${c.id}-I${seq}`, `${TAG} Item ${seq}`, c.id])).rows[0].id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [qty, rate] of layers) {
      await postStock(client, { itemId: item, warehouseId: c.wh, inQty: qty, rate, txnType: 'opening',
        refType: 'opening', refId: null, remarks: `${TAG} opening`, companyId: c.id, transactionDate: '2026-09-01' });
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return item;
}
/** An order: goods lines [{ item, qty, price, tax }] and optional service lines [{ qty, price }]. */
async function makeOrder(c, goods = [], services = []) {
  seq++;
  const so = (await pool.query(
    `INSERT INTO sales_orders (order_number, company_id, customer_name, order_status, subtotal, tax_amount, total_amount)
     VALUES ($1, $2, 'ZZ Customer', 'confirmed', 0, 0, 0) RETURNING id`, [`${TAG}-SO-${c.id}-${seq}`, c.id])).rows[0].id;
  const lines = [];
  for (const g of goods) {
    lines.push((await pool.query(
      `INSERT INTO sales_order_items (order_id, item_id, item_code, description, quantity, unit_price, tax_rate, total_amount)
       VALUES ($1, $2, 'ZZ', 'ZZ goods', $3::numeric, $4::numeric, $5::numeric, $3::numeric * $4::numeric) RETURNING id`,
      [so, g.item, g.qty, g.price ?? 150, g.tax ?? 0])).rows[0].id);
  }
  for (const s of services) {
    lines.push((await pool.query(
      `INSERT INTO sales_order_items (order_id, item_code, description, quantity, unit_price, tax_rate, total_amount)
       VALUES ($1, 'SVC', 'ZZ installation', $2::numeric, $3::numeric, 0, $2::numeric * $3::numeric) RETURNING id`, [so, s.qty, s.price])).rows[0].id);
  }
  return { so, lines };
}
/** A pick list for one order line, picked and dispatched. */
async function ship(c, so, soLine, item, qty, { dispatch = true } = {}) {
  const res = await request(appAs(c.id)).post('/warehouse/pick-lists').send({
    sales_order_id: so,
    lines: [{ item_id: item, item_name: `${TAG} Item`, bin_location_id: c.bin, bin_code: 'B', required_qty: qty,
              sales_order_item_id: soLine }],
  });
  expect(res.status).toBe(201);
  const { rows: [line] } = await pool.query(`SELECT id FROM pick_list_lines WHERE pick_list_id = $1`, [res.body.id]);
  await request(appAs(c.id)).put(`/warehouse/pick-lists/${res.body.id}/pick`)
    .send({ lines: [{ line_id: line.id, picked_qty: qty, bin_location_id: c.bin, item_id: item }] }).expect(200);
  if (dispatch) {
    await request(appAs(c.id)).patch(`/warehouse/pick-lists/${res.body.id}/status`).send({ status: 'dispatched' }).expect(200);
  }
  return { id: res.body.id, lineId: line.id };
}
const invoiceOrder = (c, so) => request(appAs(c.id)).patch(`/sales/orders/${so}/invoice`).send({});
const invoicedQty = (lineId) => num(`SELECT pick_line_invoiced_qty($1)::float`, [lineId]);
const stockRows = (item) => num(`SELECT COUNT(*)::int FROM stock_ledger WHERE item_id = $1`, [item]);
const journal = (type, refType, refId) => one(`
  SELECT COUNT(DISTINCT e.id)::int AS entries,
         COALESCE(SUM(l.debit), 0)::float AS debit, COALESCE(SUM(l.credit), 0)::float AS credit
    FROM journal_entries e LEFT JOIN journal_lines l ON l.entry_id = e.id
   WHERE e.entry_type = $1 AND e.reference_type = $2 AND e.reference_id::text = $3::text`, [type, refType, refId]);
const footprint = async (c) => ({
  invoices: await num(`SELECT COUNT(*)::int FROM invoices WHERE company_id = $1`, [c.id]),
  lines: await num(`SELECT COUNT(*)::int FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.company_id = $1`, [c.id]),
  journals: await num(`SELECT COUNT(*)::int FROM journal_entries WHERE company_id = $1`, [c.id]),
  stock: await num(`SELECT COUNT(*)::int FROM stock_ledger WHERE company_id = $1`, [c.id]),
});
const orderState = (so) => one(`SELECT order_status, invoice_id FROM sales_orders WHERE id = $1`, [so]);

beforeAll(async () => {
  await sweep();
  await makeCompany('A');
  await makeCompany('B');
}, 60_000);
afterAll(async () => {
  await sweep();
}, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
describe('sales-order invoicing through the fulfilment link', () => {
  it('bills each dispatch as it ships, at the order price and the pick cost, never moving stock', async () => {
    // 4 then 6 of 10 ordered. First pick: 4 from the layer at 80 → 80 a unit.
    // Second pick: 2 at 80 + 4 at 120 = 640 → 106.6667 a unit.
    const item = await makeItem(co.A);
    const { so, lines: [line] } = await makeOrder(co.A, [{ item, qty: 10, price: 150, tax: 18 }]);
    const p1 = await ship(co.A, so, line, item, 4);
    const rows = await stockRows(item);

    const r1 = await invoiceOrder(co.A, so);
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ fully_invoiced: false, lines: 1 });
    const inv1 = await one(`SELECT subtotal::float s, tax_amount::float t, total_amount::float tot, sales_order_id FROM invoices WHERE id = $1`, [r1.body.invoice_id]);
    expect(inv1).toEqual({ s: 600, t: 108, tot: 708, sales_order_id: so });
    const [l1] = (await pool.query(
      `SELECT pick_list_line_id, sales_order_item_id, quantity::float q, unit_cost::float c, cogs_qty::float cq
         FROM invoice_items WHERE invoice_id = $1`, [r1.body.invoice_id])).rows;
    expect(l1).toEqual({ pick_list_line_id: p1.lineId, sales_order_item_id: line, q: 4, c: 80, cq: 4 });
    expect(await journal('COGS', 'invoice', r1.body.invoice_id)).toEqual({ entries: 1, debit: 320, credit: 320 });
    expect((await orderState(so)).order_status).toBe('dispatched');

    // Nothing new shipped: refused, nothing written.
    const before = await footprint(co.A);
    const again = await invoiceOrder(co.A, so);
    expect([again.status, again.body.code]).toEqual([409, 'ALREADY_INVOICED']);
    expect(await footprint(co.A)).toEqual(before);

    const p2 = await ship(co.A, so, line, item, 6);
    const r2 = await invoiceOrder(co.A, so);
    expect(r2.status).toBe(200);
    expect(r2.body.fully_invoiced).toBe(true);
    expect(await journal('COGS', 'invoice', r2.body.invoice_id)).toEqual({ entries: 1, debit: 640, credit: 640 });
    expect(await invoicedQty(p1.lineId) + await invoicedQty(p2.lineId)).toBe(10);
    expect(await orderState(so)).toEqual({ order_status: 'invoiced', invoice_id: r1.body.invoice_id });
    expect(await stockRows(item)).toBe(rows + 1);                    // only the second pick
    expect(await num(`SELECT COUNT(*)::int FROM stock_ledger WHERE reference_type = 'invoice'
                       AND reference_id = ANY($1)`, [[r1.body.invoice_id, r2.body.invoice_id]])).toBe(0);
    const done = await invoiceOrder(co.A, so);
    expect([done.status, done.body.code]).toEqual([409, 'ALREADY_INVOICED']);
  });

  it('bills a line without an item once, alongside the goods', async () => {
    const item = await makeItem(co.A);
    const { so, lines: [goods] } = await makeOrder(co.A, [{ item, qty: 2, price: 100 }], [{ qty: 1, price: 500 }]);
    await ship(co.A, so, goods, item, 2);
    const r = await invoiceOrder(co.A, so);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ lines: 2, fully_invoiced: true });
    expect(await num(`SELECT subtotal::float FROM invoices WHERE id = $1`, [r.body.invoice_id])).toBe(700);
  });

  it('refuses, writing nothing: nothing shipped, a pick line not on the order, an older whole-order invoice, another company', async () => {
    const item = await makeItem(co.A);
    const other = await makeItem(co.A);

    const a = await makeOrder(co.A, [{ item, qty: 3 }]);
    await ship(co.A, a.so, a.lines[0], item, 3, { dispatch: false });   // picked, not dispatched
    const b = await makeOrder(co.A, [{ item, qty: 3 }]);
    await ship(co.A, b.so, null, other, 2);                              // goods not on the order
    const c = await makeOrder(co.A, [], [{ qty: 1, price: 100 }]);
    const legacy = (await pool.query(
      `INSERT INTO invoices (invoice_number, invoice_date, due_date, subtotal, tax_amount, total_amount, status, sales_order_id, company_id)
       VALUES ($1, '2026-10-01', '2026-10-31', 100, 0, 100, 'Sent', $2, $3) RETURNING id`,
      [`${TAG}-LEG-${++seq}`, c.so, co.A.id])).rows[0].id;
    await pool.query(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount) VALUES ($1, 'whole order', 1, 100, 100)`, [legacy]);

    const before = await footprint(co.A);
    const states = await Promise.all([a.so, b.so, c.so].map(orderState));
    const cases = [
      [invoiceOrder(co.A, a.so), 409, 'NOTHING_TO_INVOICE'],
      [invoiceOrder(co.A, b.so), 422, 'SO_LINE_UNRESOLVED'],
      [invoiceOrder(co.A, c.so), 409, 'ALREADY_INVOICED'],
      [invoiceOrder(co.B, a.so), 404, undefined],
    ];
    for (const [p, status, code] of cases) {
      const res = await p;
      expect([res.status, res.body.code]).toEqual([status, code]);
    }
    expect(await footprint(co.A)).toEqual(before);
    expect(await Promise.all([a.so, b.so, c.so].map(orderState))).toEqual(states);
  });

  it('is atomic: a refusal after the invoice, its lines and its revenue journal were written leaves none of them', async () => {
    // Goods costed at 0 reconcile with the ledger (cost verified) but COGS
    // refuses a zero cost — after the invoice row, lines and revenue journal.
    const item = await makeItem(co.A, [[10, 0]]);
    const { so, lines: [line] } = await makeOrder(co.A, [{ item, qty: 2 }]);
    const p = await ship(co.A, so, line, item, 2);
    const before = await footprint(co.A);
    const res = await invoiceOrder(co.A, so);
    expect([res.status, res.body.code]).toEqual([400, 'COGS_MISSING_COST']);
    expect(await footprint(co.A)).toEqual(before);
    expect(await invoicedQty(p.lineId)).toBe(0);
    expect(await orderState(so)).toEqual({ order_status: 'dispatched', invoice_id: null });
  });

  it('concurrent sales-order and direct invoices never bill a pick line beyond what shipped', async () => {
    const item = await makeItem(co.A);
    const { so, lines: [line] } = await makeOrder(co.A, [{ item, qty: 10 }]);
    const p = await ship(co.A, so, line, item, 10);
    const direct = request(appAs(co.A.id)).post('/finance/invoices').send({
      invoice_date: '2026-10-28', due_date: '2026-11-27', subtotal: 1050, tax_amount: 0, total_amount: 1050, sales_order_id: so,
      items: [{ description: 'ZZ goods', quantity: 7, unit_price: 150, amount: 1050, pick_list_line_id: p.lineId }],
    });
    const results = await Promise.all([invoiceOrder(co.A, so), invoiceOrder(co.A, so), direct]);
    expect(results.filter(r => r.status === 200 || r.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(await invoicedQty(p.lineId)).toBeLessThanOrEqual(10);
    const billed = await num(`SELECT COALESCE(SUM(quantity), 0)::float FROM invoice_items WHERE pick_list_line_id = $1`, [p.lineId]);
    expect(billed).toBe(await invoicedQty(p.lineId));
    // Whatever interleaving won, COGS was recognised for exactly what was billed.
    const cogs = await num(`
      SELECT COALESCE(SUM(l.debit), 0)::float FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
       WHERE e.entry_type = 'COGS' AND e.reference_type = 'invoice'
         AND e.reference_id::text IN (SELECT invoice_id::text FROM invoice_items WHERE pick_list_line_id = $1)`, [p.lineId]);
    expect(cogs).toBeCloseTo(billed * 96, 6);                         // 6 at 80 + 4 at 120, over 10
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('credit notes that release invoiced quantity', () => {
  /** 10 shipped and invoiced through the order; returns the invoice line. */
  async function invoicedTen(c) {
    const item = await makeItem(c);
    const { so, lines: [line] } = await makeOrder(c, [{ item, qty: 10, price: 150 }]);
    const p = await ship(c, so, line, item, 10);
    const r = await invoiceOrder(c, so);
    expect(r.status).toBe(200);
    const ii = await one(`SELECT id FROM invoice_items WHERE invoice_id = $1`, [r.body.invoice_id]);
    return { item, so, p, invoiceId: r.body.invoice_id, invoiceItemId: ii.id };
  }
  // A quantity correction: the credit names the invoice line and the exact
  // quantity it releases (Phase 3G released_qty; Phase 3H reason quantity_correction).
  const draft = (c, f, qty, extra = {}) => request(appAs(c.id)).post('/finance/credit-notes').send({
    original_invoice_id: f.invoiceId, reason: 'quantity_correction', taxable_value: qty * 150, total_amount: qty * 150,
    items: [{ original_item_id: f.invoiceItemId, description: 'ZZ goods', quantity: qty, released_qty: qty,
              unit_price: 150, taxable_value: qty * 150 }],
    ...extra,
  });
  const issue = (c, id) => request(appAs(c.id)).post(`/finance/credit-notes/${id}/issue`).send({});
  const cancel = (c, id) => request(appAs(c.id)).post(`/finance/credit-notes/${id}/cancel`).send({ reason: 'ZZ' });

  it('a draft releases nothing; issuing posts a balanced journal and releases the quantity; it is billed again with no second COGS', async () => {
    const f = await invoicedTen(co.A);
    const d = await draft(co.A, f, 3);
    expect(d.status).toBe(201);
    expect((await invoiceOrder(co.A, f.so)).body.code).toBe('ALREADY_INVOICED');   // a draft releases nothing

    const iss = await issue(co.A, d.body.data.id);
    expect(iss.status).toBe(200);
    expect(iss.body.data.posted_journal_entry_id).toBeTruthy();
    expect(await journal('CreditNote', 'credit_note', d.body.data.id)).toEqual({ entries: 1, debit: 450, credit: 450 });
    expect(await invoicedQty(f.p.lineId)).toBe(7);

    const rows = await stockRows(f.item);
    const rebill = await invoiceOrder(co.A, f.so);
    expect(rebill.status).toBe(200);
    const line = await one(`SELECT quantity::float q, cogs_qty::float cq FROM invoice_items WHERE invoice_id = $1`, [rebill.body.invoice_id]);
    expect(line).toEqual({ q: 3, cq: 0 });
    expect(await journal('COGS', 'invoice', rebill.body.invoice_id)).toEqual({ entries: 0, debit: 0, credit: 0 });
    expect(await journal('Invoice', 'invoice', rebill.body.invoice_id)).toMatchObject({ entries: 1 });
    expect(await stockRows(f.item)).toBe(rows);
    expect(await invoicedQty(f.p.lineId)).toBe(10);

    // Its release has been invoiced again: cancelling the note is refused
    // (cancellation of unfiled issued notes, migration 20261028000010).
    const c = await cancel(co.A, d.body.data.id);
    expect([c.status, c.body.code]).toEqual([409, 'CREDIT_RELEASE_CONSUMED']);
    expect((await one(`SELECT status FROM credit_notes WHERE id = $1`, [d.body.data.id])).status).toBe('issued');
  });

  it('two simultaneous issues of one note: one journal, one release', async () => {
    const f = await invoicedTen(co.A);
    const d = await draft(co.A, f, 4);
    const results = await Promise.all([issue(co.A, d.body.data.id), issue(co.A, d.body.data.id)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await journal('CreditNote', 'credit_note', d.body.data.id)).entries).toBe(1);
    expect(await invoicedQty(f.p.lineId)).toBe(6);
  });

  it('never credits more than the line billed — at drafting and again at issue', async () => {
    const f = await invoicedTen(co.A);
    const over = await draft(co.A, f, 11);
    expect([over.status, over.body.code]).toEqual([409, 'CREDIT_EXCEEDS_INVOICED']);
    const d1 = await draft(co.A, f, 6);
    const d2 = await draft(co.A, f, 6);                               // each fits on its own
    expect([d1.status, d2.status]).toEqual([201, 201]);
    await issue(co.A, d1.body.data.id).expect(200);
    const second = await issue(co.A, d2.body.data.id);
    expect([second.status, second.body.code, second.body.creditable]).toEqual([409, 'CREDIT_EXCEEDS_INVOICED', 4]);
    expect((await one(`SELECT status, posted_journal_entry_id FROM credit_notes WHERE id = $1`, [d2.body.data.id])))
      .toEqual({ status: 'draft', posted_journal_entry_id: null });
    expect(await invoicedQty(f.p.lineId)).toBe(4);
  });

  it('refuses a line of another invoice, another company\'s invoice, and acts only within the company', async () => {
    const f = await invoicedTen(co.A);
    const g = await invoicedTen(co.A);
    const wrongLine = await draft(co.A, f, 1, { reason: 'price_revision', items: [{ original_item_id: g.invoiceItemId, quantity: 1, unit_price: 150 }] });
    expect([wrongLine.status, wrongLine.body.code]).toEqual([422, 'CREDIT_LINE_NOT_ON_INVOICE']);
    const crossInvoice = await draft(co.B, f, 1);
    expect([crossInvoice.status, crossInvoice.body.code]).toEqual([404, 'ORIGINAL_INVOICE_NOT_FOUND']);
    // A body company_id does not choose the tenant.
    const spoof = await request(appAs(co.B.id)).post('/finance/credit-notes').send({
      original_invoice_id: f.invoiceId, company_id: co.A.id, reason: 'other', taxable_value: 1 });
    expect(spoof.status).toBe(404);

    const d = await draft(co.A, f, 2);
    await issue(co.B, d.body.data.id).expect(404);
    await cancel(co.B, d.body.data.id).expect(404);
    await request(appAs(co.B.id)).put(`/finance/credit-notes/${d.body.data.id}`).send({ notes: 'hijack' }).expect(404);
    await request(appAs(co.B.id)).delete(`/finance/credit-notes/${d.body.data.id}`).expect(404);
    expect((await one(`SELECT status, notes, deleted_at FROM credit_notes WHERE id = $1`, [d.body.data.id])))
      .toEqual({ status: 'draft', notes: null, deleted_at: null });
    expect(await num(`SELECT COUNT(*)::int FROM credit_notes WHERE company_id = $1`, [co.B.id])).toBe(0);
  });

  it('an issued, unfiled note cancels with a posted reversing journal and gives its release back; a filed one does not', async () => {
    const f = await invoicedTen(co.A);
    const d = await draft(co.A, f, 5);
    await issue(co.A, d.body.data.id).expect(200);
    expect(await invoicedQty(f.p.lineId)).toBe(5);
    const id = d.body.data.id;
    const { posted_journal_entry_id: je } = await one(`SELECT posted_journal_entry_id FROM credit_notes WHERE id = $1`, [id]);

    // A reason, and approval rights, are required.
    const noReason = await request(appAs(co.A.id)).post(`/finance/credit-notes/${id}/cancel`).send({});
    expect([noReason.status, noReason.body.code]).toEqual([400, 'REASON_REQUIRED']);
    const noApprove = await request(appAs(co.A.id, ['finance:edit'])).post(`/finance/credit-notes/${id}/cancel`).send({ reason: 'x' });
    expect(noApprove.status).toBe(403);
    // Written around the API, the database refuses it too: no reason / no reversing journal.
    await expect(pool.query(`UPDATE credit_notes SET status = 'cancelled' WHERE id = $1`, [id])).rejects.toThrow(/needs a reason/);
    await expect(pool.query(`UPDATE credit_notes SET status = 'cancelled', cancel_reason = 'x' WHERE id = $1`, [id]))
      .rejects.toThrow(/needs a posted journal reversing its journal/);
    await expect(pool.query(`UPDATE credit_notes SET status = 'draft' WHERE id = $1`, [id])).rejects.toThrow(/cannot be reopened/);
    await expect(pool.query(`UPDATE credit_notes SET reason = 'price_revision' WHERE id = $1`, [id])).rejects.toThrow(/reason cannot change/);
    expect((await one(`SELECT status FROM credit_notes WHERE id = $1`, [id])).status).toBe('issued');

    const ok = await request(appAs(co.A.id)).post(`/finance/credit-notes/${id}/cancel`).send({ reason: 'raised against the wrong invoice' });
    expect(ok.status).toBe(200);
    const cn = await one(`SELECT status, cancel_reason, cancelled_by, cancellation_journal_entry_id FROM credit_notes WHERE id = $1`, [id]);
    expect(cn).toMatchObject({ status: 'cancelled', cancel_reason: 'raised against the wrong invoice', cancelled_by: 1 });
    const rev = await one(`SELECT status, reversal_of_id, total_debit::float d, total_credit::float c FROM journal_entries WHERE id = $1`, [cn.cancellation_journal_entry_id]);
    expect(rev).toEqual({ status: 'posted', reversal_of_id: je, d: 750, c: 750 });
    const lines = async (e) => (await pool.query(`SELECT account_code, debit::float d, credit::float c FROM journal_lines WHERE entry_id = $1 ORDER BY account_code`, [e])).rows;
    expect(await lines(cn.cancellation_journal_entry_id)).toEqual((await lines(je)).map(l => ({ account_code: l.account_code, d: l.c, c: l.d })));
    expect(await invoicedQty(f.p.lineId)).toBe(10);                        // the release is taken back
    const again = await cancel(co.A, id);
    expect([again.status, again.body.code]).toEqual([409, 'ALREADY_CANCELLED']);

    // Once filed in GSTR-1, an issued note stays (a return amendment, not a cancellation).
    const g = await invoicedTen(co.A);
    const d2 = await draft(co.A, g, 2);
    await issue(co.A, d2.body.data.id).expect(200);
    await request(appAs(co.A.id)).post(`/finance/credit-notes/${d2.body.data.id}/mark-gstr1-filed`).send({}).expect(200);
    const filedAgain = await request(appAs(co.A.id)).post(`/finance/credit-notes/${d2.body.data.id}/mark-gstr1-filed`).send({});
    expect([filedAgain.status, filedAgain.body.code]).toEqual([409, 'ALREADY_FILED']);
    const filed = await cancel(co.A, d2.body.data.id);
    expect([filed.status, filed.body.code]).toEqual([409, 'CREDIT_NOTE_FILED']);
    await expect(pool.query(`UPDATE credit_notes SET gstr1_filed = false WHERE id = $1`, [d2.body.data.id])).rejects.toThrow(/cannot be un-filed/);
    expect(await invoicedQty(g.p.lineId)).toBe(8);
    await request(appAs(co.B.id)).post(`/finance/credit-notes/${d2.body.data.id}/mark-gstr1-filed`).send({}).expect(404);

    // A draft still cancels freely.
    const d3 = await draft(co.A, g, 1);
    await cancel(co.A, d3.body.data.id).expect(200);
    const notIssued = await request(appAs(co.A.id)).post(`/finance/credit-notes/${d3.body.data.id}/mark-gstr1-filed`).send({});
    expect([notIssued.status, notIssued.body.code]).toEqual([409, 'NOT_ISSUED']);
  });

  it('two simultaneous cancellations of one issued note: one reversal, one cancellation', async () => {
    const f = await invoicedTen(co.A);
    const d = await draft(co.A, f, 3);
    await issue(co.A, d.body.data.id).expect(200);
    const { posted_journal_entry_id: je } = await one(`SELECT posted_journal_entry_id FROM credit_notes WHERE id = $1`, [d.body.data.id]);
    const results = await Promise.all([cancel(co.A, d.body.data.id), cancel(co.A, d.body.data.id)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(await one(`SELECT COUNT(*)::int n FROM journal_entries WHERE reversal_of_id = $1`, [je])).toEqual({ n: 1 });
  });

  it('the database refuses re-billing a released quantity twice', async () => {
    const f = await invoicedTen(co.A);
    const d = await draft(co.A, f, 2);
    await issue(co.A, d.body.data.id).expect(200);
    await invoiceOrder(co.A, f.so).expect(200);                       // bills the 2 released
    await expect(pool.query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount, item_id, pick_list_line_id)
       VALUES ($1, 'sneak', 1, 1, 1, $2, $3)`, [f.invoiceId, f.item, f.p.lineId])).rejects.toThrow(/beyond its shipped quantity|duplicate key/);
    expect(await invoicedQty(f.p.lineId)).toBe(10);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('packing is idempotent', () => {
  async function picked(c, qty = 10) {
    const item = await makeItem(c);
    const { so, lines: [line] } = await makeOrder(c, [{ item, qty }]);
    const pl = await ship(c, so, line, item, qty, { dispatch: false });
    return { item, so, pl };
  }
  const pack = (c, pl, body = {}) => request(appAs(c.id)).post('/warehouse/pack').send({ pick_list_id: pl.id, ...body });
  const packed = async (pl) => one(`
    SELECT COUNT(DISTINCT p.id)::int AS packages, COUNT(pkl.id)::int AS lines, COALESCE(SUM(pkl.quantity), 0)::float AS qty
      FROM packages p LEFT JOIN package_lines pkl ON pkl.package_id = p.id
     WHERE p.pick_list_id = $1 AND LOWER(p.status) <> 'unpacked'`, [pl.id]);

  it('a retried pack writes nothing and returns the package it already has', async () => {
    const { pl } = await picked(co.A);
    const first = await pack(co.A, pl);
    expect(first.status).toBe(201);
    const again = await pack(co.A, pl);
    expect([again.status, again.body.already_packed, again.body.id]).toEqual([200, true, first.body.id]);
    await request(appAs(co.A.id)).patch(`/warehouse/pick-lists/${pl.id}/status`).send({ status: 'packed' }).expect(200);
    expect(await packed(pl)).toEqual({ packages: 1, lines: 1, qty: 10 });
  });

  it('simultaneous packs of one list build one package', async () => {
    const { pl } = await picked(co.A);
    const results = await Promise.all([pack(co.A, pl), pack(co.A, pl), pack(co.A, pl)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 200, 201]);
    expect(await packed(pl)).toEqual({ packages: 1, lines: 1, qty: 10 });
  });

  it('a partial pack leaves the rest to pack; never more than was picked', async () => {
    const { pl } = await picked(co.A);
    expect((await pack(co.A, pl, { lines: [{ pick_list_line_id: pl.lineId, quantity: 3 }] })).status).toBe(201);
    const before = await packed(pl);
    const over = await pack(co.A, pl, { lines: [{ pick_list_line_id: pl.lineId, quantity: 8 }] });
    expect([over.status, over.body.code]).toEqual([409, 'PACK_EXCEEDS_PICKED']);
    const unknown = await pack(co.A, pl, { lines: [{ pick_list_line_id: 999999999, quantity: 1 }] });
    expect([unknown.status, unknown.body.code]).toEqual([422, 'PACK_LINE_UNRESOLVED']);
    expect(await packed(pl)).toEqual(before);
    expect((await pack(co.A, pl)).status).toBe(201);                 // the remaining 7
    expect(await packed(pl)).toEqual({ packages: 2, lines: 2, qty: 10 });
    expect((await pack(co.A, pl)).status).toBe(200);
  });

  it('after an unpack the goods pack again, once', async () => {
    const { pl } = await picked(co.A);
    await pack(co.A, pl).expect(201);
    await request(appAs(co.A.id)).post(`/warehouse/pick-lists/${pl.id}/unpack`).send({}).expect(200);
    await pack(co.A, pl).expect(201);
    await pack(co.A, pl).expect(200);
    expect(await packed(pl)).toEqual({ packages: 1, lines: 1, qty: 10 });
  });

  it('two lists packed at once get different package numbers', async () => {
    const a = await picked(co.A, 2);
    const b = await picked(co.A, 2);
    const [ra, rb] = await Promise.all([pack(co.A, a.pl), pack(co.A, b.pl)]);
    expect([ra.status, rb.status]).toEqual([201, 201]);
    expect(ra.body.package_no).not.toBe(rb.body.package_no);
  });
});
