/**
 * integration.phase3G.test.js — financial, fulfilment and QC integrity
 * (Phase 3G). Against the REAL database, through the REAL routers.
 *
 * WHAT IS PROVED
 *   1. Sales-order dispatch ships non-stock orders only: an order with stock
 *      goods not shipped through a dispatched pick list is refused (force
 *      included), writing nothing.
 *   2. Credit notes release quantity only by an explicit released_qty, on a
 *      sales_return / other note, against a pick-linked line of the original
 *      invoice — never a price credit; a sales-return release never exceeds
 *      what came back; a returned unit is never billable again (order-item
 *      rule, also in the trigger); concurrent issues cannot over-release.
 *   3. (with the 3F suite) issued notes cannot be cancelled; the database
 *      refuses it too.
 *   4. One credit-note number generator: per company and year, distinct
 *      under concurrency, companies independent, both writers share it; the
 *      database refuses a duplicate within a company.
 *   5. Explicit QC requirements hold with the global gate off, on both
 *      dispatch paths; the gate switch still governs the record checks.
 *   6. production_orders.product_id is a real, company-checked reference.
 *   7. Journal reversal pairs: a draft reversal is not reported as a reversal;
 *      it cannot be posted before its original; neither leg can be edited or
 *      deleted while the pair stands.
 *   8. Returns close only after every line is received, with a consistent
 *      record and an issued credit note; partial receipts; withdrawal is the
 *      authorised non-receipt path.
 *
 * Every refusal is checked against the database. Cleanup deletes only this
 * suite's companies (TAG-coded), table by table.
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
    allowRoles: () => (req, res, next) => next(),
  };
});

const { default: pool }              = await import('../config/db.js');
const { default: warehouseRouter }   = await import('../modules/warehouse/warehouse.routes.js');
const { default: salesRouter }       = await import('../modules/sales/routes/sales.routes.js');
const { default: financeRouter }     = await import('../modules/finance/routes/finance.routes.js');
const { default: creditNotesRouter } = await import('../modules/finance/creditNotes.routes.js');
const { default: accountingRouter }  = await import('../modules/finance/accounting.routes.js');
const { default: fulfilmentRouter }  = await import('../modules/sales/fulfilment.routes.js');
const { default: scmRouter }         = await import('../modules/logistics/scmPlanning.routes.js');
const { default: qualityRouter }     = await import('../modules/quality/quality.routes.js');
const { default: executionRouter }   = await import('../modules/production/execution.routes.js');
const { postStock }                  = await import('../modules/production/subcontracting.routes.js');

const TAG = 'ZZG3G';
const RUN = Date.now();   // fixture journal numbers are globally unique (journal_entries_entry_number_key)

function appAs(companyId, perms = '*') {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    req.user  = { userId: 1, id: 1, roles: ['admin'], company_id: companyId, perms };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/warehouse', warehouseRouter);
  app.use('/sales/fulfilment', fulfilmentRouter);
  app.use('/sales', salesRouter);
  app.use('/finance/credit-notes', creditNotesRouter);
  app.use('/finance/accounting', accountingRouter);
  app.use('/finance', financeRouter);
  app.use('/scm', scmRouter);
  app.use('/quality', qualityRouter);
  app.use('/production', executionRouter);
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
    `DELETE FROM qc_requirements WHERE company_id = ANY($1)`,
    `DELETE FROM sales_return_items WHERE company_id = ANY($1)`,
    `DELETE FROM sales_returns WHERE company_id = ANY($1)`,
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
    `DELETE FROM test_runs WHERE company_id = ANY($1)`,
    `DELETE FROM quality_tests WHERE production_order_id IN (SELECT id FROM production_orders WHERE company_id = ANY($1))`,
    `DELETE FROM production_orders WHERE company_id = ANY($1)`,
    `DELETE FROM sales_order_items WHERE order_id IN (SELECT id FROM sales_orders WHERE company_id = ANY($1))`,
    `DELETE FROM sales_orders WHERE company_id = ANY($1)`,
    `DELETE FROM quality_settings WHERE company_id = ANY($1)`,
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
async function makeItem(c, layers = [[100, 80]]) {
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
async function makeOrder(c, goods = [], services = []) {
  seq++;
  const so = (await pool.query(
    `INSERT INTO sales_orders (order_number, company_id, customer_name, order_status, subtotal, tax_amount, total_amount)
     VALUES ($1, $2, 'ZZ Customer', 'confirmed', 0, 0, 0) RETURNING id`, [`${TAG}-SO-${c.id}-${seq}`, c.id])).rows[0].id;
  const lines = [];
  for (const g of goods) {
    lines.push((await pool.query(
      `INSERT INTO sales_order_items (order_id, item_id, item_code, description, quantity, unit_price, tax_rate, total_amount)
       VALUES ($1, $2, 'ZZ', 'ZZ goods', $3::numeric, $4::numeric, 0, $3::numeric * $4::numeric) RETURNING id`,
      [so, g.item, g.qty, g.price ?? 150])).rows[0].id);
  }
  for (const s of services) {
    lines.push((await pool.query(
      `INSERT INTO sales_order_items (order_id, item_code, description, quantity, unit_price, tax_rate, total_amount)
       VALUES ($1, 'SVC', 'ZZ installation', $2::numeric, $3::numeric, 0, $2::numeric * $3::numeric) RETURNING id`,
      [so, s.qty, s.price])).rows[0].id);
  }
  return { so, lines };
}
async function ship(c, so, soLine, item, qty) {
  const res = await request(appAs(c.id)).post('/warehouse/pick-lists').send({
    sales_order_id: so,
    lines: [{ item_id: item, item_name: `${TAG} Item`, bin_location_id: c.bin, bin_code: 'B', required_qty: qty, sales_order_item_id: soLine }],
  });
  expect(res.status).toBe(201);
  const { rows: [line] } = await pool.query(`SELECT id FROM pick_list_lines WHERE pick_list_id = $1`, [res.body.id]);
  await request(appAs(c.id)).put(`/warehouse/pick-lists/${res.body.id}/pick`)
    .send({ lines: [{ line_id: line.id, picked_qty: qty, bin_location_id: c.bin, item_id: item }] }).expect(200);
  await request(appAs(c.id)).patch(`/warehouse/pick-lists/${res.body.id}/status`).send({ status: 'dispatched' }).expect(200);
  return { id: res.body.id, lineId: line.id };
}
/** 10 shipped and invoiced through the order. */
async function invoicedTen(c) {
  const item = await makeItem(c);
  const { so, lines: [line] } = await makeOrder(c, [{ item, qty: 10 }]);
  const p = await ship(c, so, line, item, 10);
  const r = await request(appAs(c.id)).patch(`/sales/orders/${so}/invoice`).send({});
  expect(r.status).toBe(200);
  const ii = await one(`SELECT id FROM invoice_items WHERE invoice_id = $1`, [r.body.invoice_id]);
  return { item, so, p, invoiceId: r.body.invoice_id, invoiceItemId: ii.id };
}
const note = (c, f, { reason = 'quantity_correction', qty = 1, released = qty, itemId = f.invoiceItemId } = {}) =>
  request(appAs(c.id)).post('/finance/credit-notes').send({
    original_invoice_id: f.invoiceId, reason, taxable_value: qty * 150, total_amount: qty * 150,
    items: [{ original_item_id: itemId, description: 'ZZ', quantity: qty, unit_price: 150, taxable_value: qty * 150,
              ...(released != null ? { released_qty: released } : {}) }],
  });
const issue = (c, id) => request(appAs(c.id)).post(`/finance/credit-notes/${id}/issue`).send({});
const invoicedQty = (lineId) => num(`SELECT pick_line_invoiced_qty($1)::float`, [lineId]);
const invoiceOrder = (c, so) => request(appAs(c.id)).patch(`/sales/orders/${so}/invoice`).send({});
/** A return of `qty` received with the given disposition. */
async function returned(c, f, qty, disposition = 'scrap') {
  const r = await request(appAs(c.id)).post('/scm/returns').send({ sales_order_id: f.so, lines: [{ item_id: f.item, quantity: qty }] });
  expect(r.status).toBe(201);
  await request(appAs(c.id)).post(`/scm/returns/${r.body.id}/receive`)
    .send({ lines: [{ id: r.body.items[0].id, disposition }] }).expect(200);
  return r.body;
}

beforeAll(async () => {
  await sweep();
  await makeCompany('A');
  await makeCompany('B');
}, 60_000);
afterAll(async () => {
  await sweep();
}, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
describe('1. sales-order dispatch ships non-stock orders only', () => {
  it('an order with stock goods not shipped by a pick list is refused, force included, writing nothing', async () => {
    const item = await makeItem(co.A);
    const { so } = await makeOrder(co.A, [{ item, qty: 2 }], [{ qty: 1, price: 100 }]);
    for (const force of [false, true]) {
      const res = await request(appAs(co.A.id)).put(`/sales/orders/${so}/dispatch`).send({ carrier: 'ZZ', force });
      expect([res.status, res.body.code]).toEqual([409, 'STOCK_REQUIRES_PICK_LIST']);
      expect(res.body.lines).toEqual([expect.objectContaining({ item_id: item, ordered: 2, shipped: 0 })]);
    }
    expect(await num(`SELECT COUNT(*)::int FROM shipments WHERE sales_order_id = $1`, [so])).toBe(0);
    expect((await one(`SELECT order_status FROM sales_orders WHERE id = $1`, [so])).order_status).toBe('confirmed');
  });

  it('a service-only order still dispatches here, and invoices its service line', async () => {
    const { so } = await makeOrder(co.A, [], [{ qty: 1, price: 500 }]);
    const res = await request(appAs(co.A.id)).put(`/sales/orders/${so}/dispatch`).send({ carrier: 'ZZ' });
    expect(res.status).toBe(200);
    expect(res.body.dispatch_ref).toMatch(/^DSP-/);
    const inv = await invoiceOrder(co.A, so);
    expect([inv.status, inv.body.lines]).toEqual([200, 1]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('2. credit-note quantity rules', () => {
  it('a price credit releases nothing, and may not name a release', async () => {
    const f = await invoicedTen(co.A);
    const priced = await note(co.A, f, { reason: 'price_revision', qty: 10, released: null });
    expect(priced.status).toBe(201);
    await issue(co.A, priced.body.data.id).expect(200);
    expect(await invoicedQty(f.p.lineId)).toBe(10);                      // nothing came free to bill again
    for (const reason of ['price_revision', 'post_sale_discount', 'deficiency_of_service', 'other']) {
      const res = await note(co.A, f, { reason, qty: 2, released: 2 });
      expect([reason, res.status, res.body.code]).toEqual([reason, 422, 'RELEASE_NOT_ALLOWED_FOR_REASON']);
    }
    // The database refuses the same release written around the API.
    await expect(pool.query(
      `INSERT INTO credit_note_items (credit_note_id, original_item_id, quantity, released_qty) VALUES ($1, $2, 1, 1)`,
      [priced.body.data.id, f.invoiceItemId])).rejects.toThrow(/credits price only/);
  });

  it('a release names the original line and an exact quantity within what it credits', async () => {
    const f = await invoicedTen(co.A);
    const before = await num(`SELECT COUNT(*)::int FROM credit_notes WHERE company_id = $1`, [co.A.id]);
    const svc = await makeOrder(co.A, [], [{ qty: 1, price: 100 }]);
    await request(appAs(co.A.id)).put(`/sales/orders/${svc.so}/dispatch`).send({}).expect(200);
    const svcInv = (await invoiceOrder(co.A, svc.so)).body.invoice_id;
    const svcLine = (await one(`SELECT id FROM invoice_items WHERE invoice_id = $1`, [svcInv])).id;
    const cases = [
      [request(appAs(co.A.id)).post('/finance/credit-notes').send({ original_invoice_id: f.invoiceId, reason: 'sales_return', taxable_value: 1,
        items: [{ quantity: 1, released_qty: 1 }] }), 422, 'RELEASE_LINE_REQUIRED'],
      [note(co.A, f, { reason: 'sales_return', qty: 2, released: 3 }), 422, 'RELEASE_EXCEEDS_CREDITED'],
      [note(co.A, f, { reason: 'sales_return', qty: 2, released: 0 }), 422, 'RELEASE_QTY_INVALID'],
      [note(co.A, { invoiceId: svcInv, invoiceItemId: svcLine }, { qty: 1, released: 1 }), 422, 'NO_QUANTITY_TO_RELEASE'],
      [note(co.A, f, { qty: 10, released: 10 }).then(async (r) => { await issue(co.A, r.body.data.id).expect(200);
        return note(co.A, f, { qty: 1, released: 1 }); }), 409, 'CREDIT_EXCEEDS_INVOICED'],
    ];
    for (const [p, status, code] of cases) {
      const res = await p;
      expect([code, res.status, res.body.code]).toEqual([code, status, code]);
    }
    expect(await num(`SELECT COUNT(*)::int FROM credit_notes WHERE company_id = $1`, [co.A.id])).toBe(before + 1);
  });

  it('a sales-return release never exceeds what came back, and returned units are never billable again', async () => {
    const f = await invoicedTen(co.A);
    const early = await note(co.A, f, { reason: 'sales_return', qty: 3, released: 3 });
    expect([early.status, early.body.code, early.body.creditable]).toEqual([409, 'RELEASE_EXCEEDS_RETURNED', 0]);   // nothing back yet
    await returned(co.A, f, 2);
    const tooMany = await note(co.A, f, { reason: 'sales_return', qty: 3, released: 3 });
    expect([tooMany.status, tooMany.body.creditable]).toEqual([409, 2]);
    const d = await note(co.A, f, { reason: 'sales_return', qty: 2, released: 2 });
    await issue(co.A, d.body.data.id).expect(200);
    expect(await invoicedQty(f.p.lineId)).toBe(8);
    // Released, but the 2 are back with us: shipped 10 − returned 2 = 8 = invoiced, so nothing is billable.
    const rebill = await invoiceOrder(co.A, f.so);
    expect([rebill.status, rebill.body.code]).toEqual([409, 'ALREADY_INVOICED']);
    const direct = await request(appAs(co.A.id)).post('/finance/invoices').send({
      invoice_date: '2026-10-28', due_date: '2026-11-27', subtotal: 150, tax_amount: 0, total_amount: 150, sales_order_id: f.so,
      items: [{ description: 'ZZ', quantity: 1, unit_price: 150, amount: 150, pick_list_line_id: f.p.lineId }] });
    expect([direct.status, direct.body.code]).toEqual([409, 'FULFILMENT_RETURNED']);
    await expect(pool.query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount, item_id, pick_list_line_id)
       VALUES ($1, 'sneak', 1, 1, 1, $2, $3)`, [f.invoiceId, f.item, f.p.lineId])).rejects.toThrow(/less what was returned/);
    expect(await invoicedQty(f.p.lineId)).toBe(8);
  });

  it('a unit returned after a quantity correction is not billable again either', async () => {
    const f = await invoicedTen(co.A);
    const fix = await note(co.A, f, { reason: 'quantity_correction', qty: 3, released: 3 });
    await issue(co.A, fix.body.data.id).expect(200);
    await returned(co.A, f, 3);                                            // 3 came back after the correction
    const res = await invoiceOrder(co.A, f.so);
    expect(res.status).not.toBe(200);
    expect(await invoicedQty(f.p.lineId)).toBe(7);
  });

  it('two notes issued at once cannot release more than the line billed', async () => {
    const f = await invoicedTen(co.A);
    const a = await note(co.A, f, { qty: 6, released: 6 });
    const b = await note(co.A, f, { qty: 6, released: 6 });
    const results = await Promise.all([issue(co.A, a.body.data.id), issue(co.A, b.body.data.id)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(await invoicedQty(f.p.lineId)).toBe(4);
    expect(await num(`SELECT COALESCE(SUM(released_qty), 0)::float FROM credit_note_items cni JOIN credit_notes cn ON cn.id = cni.credit_note_id
                       WHERE cni.original_item_id = $1 AND cn.status = 'issued'`, [f.invoiceItemId])).toBe(6);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('4. one credit-note number generator', () => {
  const year = new Date().getFullYear();
  it('simultaneous creates in one company get distinct consecutive numbers; another company numbers on its own', async () => {
    const f = await invoicedTen(co.A);
    const fB = await invoicedTen(co.B);
    // Header-only notes: no credit line, so nothing else (an invoice-line lock)
    // serialises them — only the generator's own lock keeps the numbers apart.
    const results = await Promise.all(Array.from({ length: 5 }, () => request(appAs(co.A.id)).post('/finance/credit-notes')
      .send({ original_invoice_id: f.invoiceId, reason: 'price_revision', taxable_value: 10, total_amount: 10 })));
    expect(results.every(r => r.status === 201)).toBe(true);
    const numbers = results.map(r => r.body.data.credit_note_number);
    expect(new Set(numbers).size).toBe(5);
    expect(numbers.every(n => new RegExp(`^CN-${year}-\\d{4,}$`).test(n))).toBe(true);
    const seqs = numbers.map(n => Number(n.split('-')[2])).sort((x, y) => x - y);
    expect(seqs.at(-1) - seqs[0]).toBe(4);
    const b = await note(co.B, fB, { reason: 'price_revision', released: null });
    expect(b.body.data.credit_note_number).toBe(`CN-${year}-0001`);
  });

  it('the sales credit route draws from the same generator, and the database refuses a duplicate within a company', async () => {
    const f = await invoicedTen(co.A);
    const a = await note(co.A, f, { reason: 'price_revision', released: null });
    const viaSales = await request(appAs(co.A.id)).post('/sales/fulfilment/credit').send({ invoice_id: f.invoiceId, reason: 'price_revision', amount: 10 });
    expect(viaSales.status).toBe(201);
    const n1 = Number(a.body.data.credit_note_number.split('-')[2]);
    expect(viaSales.body.credit_note_number).toBe(`CN-${year}-${String(n1 + 1).padStart(4, '0')}`);
    await expect(pool.query(
      `INSERT INTO credit_notes (credit_note_number, reason, company_id) VALUES ($1, 'other', $2)`,
      [a.body.data.credit_note_number, co.A.id])).rejects.toThrow(/ux_credit_notes_company_number/);
    // …while the same number in another company is fine.
    await pool.query(`INSERT INTO credit_notes (credit_note_number, reason, company_id) VALUES ($1, 'other', $2)`,
      [a.body.data.credit_note_number, co.B.id]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('5. explicit QC requirements hold with the gate off', () => {
  async function qcReady(c, { service = false } = {}) {
    const item = await makeItem(c);
    const { so, lines: [line] } = await makeOrder(c, service ? [] : [{ item, qty: 2 }], service ? [{ qty: 1, price: 10 }] : []);
    const po = (await pool.query(
      `INSERT INTO production_orders (production_order_no, product_name, product_id, quantity_planned, status, sales_order_id, company_id)
       VALUES ($1, 'ZZ', $2, 1, 'completed', $3, $4) RETURNING id`, [`${TAG}-PO-${++seq}`, item, so, c.id])).rows[0].id;
    let pl = null;
    if (!service) {
      const res = await request(appAs(c.id)).post('/warehouse/pick-lists').send({ sales_order_id: so,
        lines: [{ item_id: item, item_name: 'ZZ', bin_location_id: c.bin, bin_code: 'B', required_qty: 2, sales_order_item_id: line }] });
      const { rows: [l] } = await pool.query(`SELECT id FROM pick_list_lines WHERE pick_list_id = $1`, [res.body.id]);
      await request(appAs(c.id)).put(`/warehouse/pick-lists/${res.body.id}/pick`)
        .send({ lines: [{ line_id: l.id, picked_qty: 2, bin_location_id: c.bin, item_id: item }] }).expect(200);
      pl = res.body.id;
    }
    return { item, so, po, pl };
  }
  const gateOff = (c) => pool.query(
    `INSERT INTO quality_settings (company_id, fat_dispatch_gate) VALUES ($1, false)
     ON CONFLICT (company_id) DO UPDATE SET fat_dispatch_gate = false`, [c.id]);

  it('warehouse dispatch: gate off still blocks a configured requirement, but not a failed test', async () => {
    await gateOff(co.A);
    const f = await qcReady(co.A);
    await pool.query(`INSERT INTO quality_tests (source_type, test_name, production_order_id, result, status, company_id)
                      VALUES ('production', 'ZZ', $1, 'fail', 'completed', $2)`, [f.po, co.A.id]);
    await request(appAs(co.A.id)).post('/quality/qc-requirements').send({ sales_order_id: f.so, inspection: 'FAT' }).expect(201);
    const res = await request(appAs(co.A.id)).post('/warehouse/dispatch').send({ pick_list_id: f.pl });
    expect([res.status, res.body.code, res.body.blockers.map(b => b.kind)]).toEqual([409, 'FAT_GATE', ['REQUIRED_MISSING']]);
    const ready = await request(appAs(co.A.id)).get('/quality/dispatch-readiness').query({ sales_order_id: f.so });
    expect(ready.body.data).toMatchObject({ gate_on: false, qc_plan: 'configured', ready: false });

    await pool.query(`INSERT INTO test_runs (production_order_id, test_stage, test_type, overall_result, status, company_id)
                      VALUES ($1, 'FAT', 'functional', 'pass', 'completed', $2)`, [f.po, co.A.id]);
    expect((await request(appAs(co.A.id)).post('/warehouse/dispatch').send({ pick_list_id: f.pl })).status).toBe(200);   // the failed test is the gate's, and it is off
  });

  it('sales-order dispatch: the same', async () => {
    await gateOff(co.A);
    const f = await qcReady(co.A, { service: true });
    await request(appAs(co.A.id)).post('/quality/qc-requirements').send({ sales_order_id: f.so, inspection: 'quality_test' }).expect(201);
    const res = await request(appAs(co.A.id)).put(`/sales/orders/${f.so}/dispatch`).send({ force: true });
    expect([res.status, res.body.code, res.body.blockers.map(b => b.kind)]).toEqual([409, 'FAT_GATE', ['REQUIRED_MISSING']]);
    expect(await num(`SELECT COUNT(*)::int FROM shipments WHERE sales_order_id = $1`, [f.so])).toBe(0);
    await pool.query(`DELETE FROM quality_settings WHERE company_id = $1`, [co.A.id]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('6. production_orders.product_id', () => {
  it('is a foreign key to inventory items, and the create route takes only the company\'s own', async () => {
    await expect(pool.query(
      `INSERT INTO production_orders (production_order_no, product_name, product_id, quantity_planned, company_id)
       VALUES ($1, 'ZZ', -1, 1, $2)`, [`${TAG}-PO-${++seq}`, co.A.id])).rejects.toThrow(/production_orders_product_id_fkey/);
    const itemB = await makeItem(co.B);
    const res = await request(appAs(co.A.id)).post('/production/orders').send({ product_name: 'ZZ', product_id: itemB, quantity_planned: 1 });
    expect([res.status, res.body.code]).toEqual([422, 'PRODUCT_NOT_FOUND']);
    expect(await num(`SELECT COUNT(*)::int FROM production_orders WHERE product_id = $1`, [itemB])).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('7. journal reversal pairs', () => {
  async function pair(c) {
    const { rows: accts } = await pool.query(`SELECT id, code, name FROM chart_of_accounts WHERE code IN ('1010', '4001') AND company_id IS NULL AND is_active`);
    const ar = accts.find(a => a.code === '1010'), rev = accts.find(a => a.code === '4001');
    const mk = async (reversalOf, d, k) => {
      const { rows: [e] } = await pool.query(
        `INSERT INTO journal_entries (entry_number, entry_date, entry_type, reference_type, status, reversal_of_id, total_debit, total_credit, company_id)
         VALUES ($1, CURRENT_DATE, 'auto', 'iot_service', 'draft', $2, 100, 100, $3) RETURNING id`, [`${TAG}-JE-${RUN}-${++seq}`, reversalOf, c.id]);
      for (const [a, dr, cr] of [[ar, d, k], [rev, k, d]]) {
        await pool.query(`INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, company_id)
                          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [e.id, a.id, a.code, a.name, dr, cr, c.id]);
      }
      return e.id;
    };
    const original = await mk(null, 100, 0);
    const reversal = await mk(original, 0, 100);
    return { original, reversal };
  }
  const acct = (c) => appAs(c.id);
  const getEntry = (c, id) => request(acct(c)).get(`/finance/accounting/journal-entries/${id}`);

  it('a draft reversal is pending, not a reversal; it posts only after the original; then both are a reversal', async () => {
    const p = await pair(co.A);
    expect((await getEntry(co.A, p.original)).body).toMatchObject({ is_reversed: false, reversal_pending: true, reversal_status: 'draft' });
    const early = await request(acct(co.A)).post(`/finance/accounting/journal-entries/${p.reversal}/post`).send({});
    expect([early.status, early.body.code]).toEqual([409, 'ORIGINAL_NOT_POSTED']);
    expect((await one(`SELECT status FROM journal_entries WHERE id = $1`, [p.reversal])).status).toBe('draft');
    await request(acct(co.A)).post(`/finance/accounting/journal-entries/${p.original}/post`).send({}).expect(200);
    await request(acct(co.A)).post(`/finance/accounting/journal-entries/${p.reversal}/post`).send({}).expect(200);
    expect((await getEntry(co.A, p.original)).body).toMatchObject({ is_reversed: true, reversal_pending: false });
  });

  it('neither leg of a pair can be edited or deleted', async () => {
    const p = await pair(co.A);
    for (const id of [p.original, p.reversal]) {
      const del = await request(acct(co.A)).delete(`/finance/accounting/journal-entries/${id}`);
      expect([del.status, del.body.code]).toEqual([409, 'REVERSAL_PAIR_LOCKED']);
      const put = await request(acct(co.A)).put(`/finance/accounting/journal-entries/${id}`).send({ description: 'x', lines: [{ account_id: 1, debit: 1, credit: 0 }] });
      expect([put.status, put.body.code]).toEqual([409, 'REVERSAL_PAIR_LOCKED']);
    }
    expect(await num(`SELECT COUNT(*)::int FROM journal_entries WHERE id = ANY($1) AND deleted_at IS NULL`, [[p.original, p.reversal]])).toBe(2);
    await request(acct(co.B)).post(`/finance/accounting/journal-entries/${p.original}/post`).send({}).expect(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('8. return closure', () => {
  async function rma(c, lines) {
    const item = await makeItem(c);
    const { so, lines: [line] } = await makeOrder(c, [{ item, qty: 10 }]);
    await ship(c, so, line, item, 10);
    const r = await request(appAs(c.id)).post('/scm/returns').send({ sales_order_id: so,
      lines: lines.map(q => ({ item_id: item, quantity: q.qty, ...(q.serial ? { serial_id: q.serial } : {}) })) });
    // Two lines of one item: give the second a serial-free distinct shape via a second item if needed.
    expect(r.status).toBe(201);
    return { ...r.body, item, so };
  }
  const receive = (c, id, lines) => request(appAs(c.id)).post(`/scm/returns/${id}/receive`).send({ lines });
  const close = (c, id, body = {}) => request(appAs(c.id)).post(`/scm/returns/${id}/close`).send(body);

  it('closes only once every line is received — receipts may come in parts, each line once', async () => {
    const item = await makeItem(co.A), item2 = await makeItem(co.A);
    const { so, lines: [l1, l2] } = await makeOrder(co.A, [{ item, qty: 5 }, { item: item2, qty: 5 }]);
    await ship(co.A, so, l1, item, 5);
    await ship(co.A, so, l2, item2, 5);
    const r = (await request(appAs(co.A.id)).post('/scm/returns').send({ sales_order_id: so,
      lines: [{ item_id: item, quantity: 2 }, { item_id: item2, quantity: 3 }] })).body;
    const [a, b] = r.items;
    await receive(co.A, r.id, [{ id: a.id, disposition: 'scrap', received_qty: 1 }]).expect(200);
    expect((await one(`SELECT status, received_at FROM sales_returns WHERE id = $1`, [r.id]))).toEqual({ status: 'partially_received', received_at: null });
    const again = await receive(co.A, r.id, [{ id: a.id, disposition: 'scrap' }]);
    expect([again.status, again.body.code]).toEqual([409, 'LINE_ALREADY_RECEIVED']);
    const early = await close(co.A, r.id);
    expect([early.status, early.body.code, early.body.lines]).toEqual([409, 'RECEIPT_OUTSTANDING', [b.id]]);
    const noWithdraw = await request(appAs(co.A.id)).post(`/scm/returns/${r.id}/withdraw`).send({ reason: 'x' });
    expect([noWithdraw.status, noWithdraw.body.code]).toEqual([409, 'RETURN_HAS_RECEIPTS']);

    await receive(co.A, r.id, [{ id: b.id, disposition: 'restock' }]).expect(200);
    expect((await one(`SELECT status FROM sales_returns WHERE id = $1`, [r.id])).status).toBe('received');
    expect((await pool.query(`SELECT id, received_qty::float q FROM sales_return_items WHERE return_id = $1 ORDER BY id`, [r.id])).rows)
      .toEqual([{ id: a.id, q: 1 }, { id: b.id, q: 3 }]);                  // the scrapped quantity is recorded too
    await close(co.A, r.id).expect(200);
  });

  it('refuses a record whose stock effect does not reconcile', async () => {
    const r = await rma(co.A, [{ qty: 2 }]);
    await receive(co.A, r.id, [{ id: r.items[0].id, disposition: 'restock' }]).expect(200);
    await pool.query(`UPDATE sales_return_items SET restocked_qty = 1 WHERE id = $1`, [r.items[0].id]);   // the record says 1, the ledger moved 2
    const res = await close(co.A, r.id);
    expect([res.status, res.body.code]).toEqual([409, 'RETURN_STOCK_MISMATCH']);
    await pool.query(`UPDATE sales_return_items SET restocked_qty = 2, disposition = 'scrap' WHERE id = $1`, [r.items[0].id]);
    const res2 = await close(co.A, r.id);
    expect([res2.status, res2.body.code]).toEqual([409, 'RETURN_RECORD_INCONSISTENT']);
    expect((await one(`SELECT status FROM sales_returns WHERE id = $1`, [r.id])).status).toBe('received');
  });

  it('withdrawal is the authorised non-receipt closure: approve permission, a reason, nothing moved', async () => {
    const r = await rma(co.A, [{ qty: 2 }]);
    const stock = await num(`SELECT COUNT(*)::int FROM stock_ledger WHERE company_id = $1`, [co.A.id]);
    await request(appAs(co.A.id, ['sales:edit'])).post(`/scm/returns/${r.id}/withdraw`).send({ reason: 'kept by customer' }).expect(403);
    const noReason = await request(appAs(co.A.id)).post(`/scm/returns/${r.id}/withdraw`).send({});
    expect([noReason.status, noReason.body.code]).toEqual([400, 'REASON_REQUIRED']);
    await request(appAs(co.B.id)).post(`/scm/returns/${r.id}/withdraw`).send({ reason: 'x' }).expect(404);
    const ok = await request(appAs(co.A.id)).post(`/scm/returns/${r.id}/withdraw`).send({ reason: 'kept by customer' });
    expect(ok.status).toBe(200);
    expect(await one(`SELECT status, closed_without_receipt, close_reason, closed_by, credit_note_id FROM sales_returns WHERE id = $1`, [r.id]))
      .toEqual({ status: 'closed', closed_without_receipt: true, close_reason: 'kept by customer', closed_by: 1, credit_note_id: null });
    expect(await num(`SELECT COUNT(*)::int FROM stock_ledger WHERE company_id = $1`, [co.A.id])).toBe(stock);
    const recv = await receive(co.A, r.id, [{ id: r.items[0].id, disposition: 'scrap' }]);
    expect([recv.status, recv.body.code]).toEqual([409, 'RETURN_CLOSED']);
    // A withdrawn return's quantity is free to be requested again.
    const elig = await request(appAs(co.A.id)).get('/scm/returns/eligible').query({ sales_order_id: r.so });
    expect(elig.body.items[0]).toMatchObject({ open_requested_qty: 0, requestable_qty: 10 });
  });
});
