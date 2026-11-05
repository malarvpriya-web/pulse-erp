/**
 * integration.phase3H.test.js — reason codes, historical receipts, legacy
 * order reconciliation, orphan-journal report (Phase 3H). Against the REAL
 * database, through the REAL routers, on isolated TAG-coded companies only.
 *
 * WHAT IS PROVED
 *   1. 'quantity_correction' is the explicit quantity-error reason: it must be
 *      release lines (original line named, released_qty = quantity); 'other'
 *      and every price reason can no longer release — API and database; the
 *      amount-only sales credit route does not offer it.
 *   2. The receipt-gap report finds received lines with no received_qty,
 *      classifies them from evidence only (a reconciling restock is verified,
 *      everything else unresolved — never the requested quantity), and writes
 *      nothing. The correction path needs sales:approve and evidence, checks
 *      the evidence, fills one gap once, moves no stock, is audited, and lets
 *      the return close.
 *   3. The fulfilment-reconciliation report classifies legacy orders by their
 *      records, is company-scoped, writes nothing, and the Phase 3G
 *      safeguards still refuse invoicing and returns for those orders.
 *   4. The orphan-journal report script runs read-only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
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
const { default: fulfilmentRouter }  = await import('../modules/sales/fulfilment.routes.js');
const { default: scmRouter }         = await import('../modules/logistics/scmPlanning.routes.js');
const { postStock }                  = await import('../modules/production/subcontracting.routes.js');
const links                          = await import('../../scripts/reconciliation/legacyFulfilmentLinks.js');

const TAG = 'ZZH3H';

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
  app.use('/finance', financeRouter);
  app.use('/scm', scmRouter);
  return app;
}

const co = {};
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
const num = async (sql, params = []) => Number(Object.values((await pool.query(sql, params)).rows[0])[0]);

// Invoices before the journals they reference (invoices_journal_entry_id_fkey),
// or the journal delete fails and the journals outlive the company.
async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  const items = `(SELECT id FROM inventory_items WHERE company_id = ANY($1))`;
  const steps = [
    `DELETE FROM legacy_fulfilment_links WHERE company_id = ANY($1)`,
    `DELETE FROM sales_return_receipt_corrections WHERE company_id = ANY($1)`,
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
async function makeItem(c) {
  seq++;
  const item = (await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, standard_cost)
     VALUES ($1, $2, $3, 'NOS', 100) RETURNING id`, [`${TAG}-${c.id}-I${seq}`, `${TAG} Item ${seq}`, c.id])).rows[0].id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await postStock(client, { itemId: item, warehouseId: c.wh, inQty: 100, rate: 80, txnType: 'opening',
      refType: 'opening', refId: null, remarks: `${TAG} opening`, companyId: c.id, transactionDate: '2026-09-01' });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return item;
}
async function makeOrder(c, goods = [], status = 'confirmed') {
  seq++;
  const so = (await pool.query(
    `INSERT INTO sales_orders (order_number, company_id, customer_name, order_status, subtotal, tax_amount, total_amount)
     VALUES ($1, $2, 'ZZ Customer', $3, 0, 0, 0) RETURNING id`, [`${TAG}-SO-${c.id}-${seq}`, c.id, status])).rows[0].id;
  const lines = [];
  for (const g of goods) {
    lines.push((await pool.query(
      `INSERT INTO sales_order_items (order_id, item_id, item_code, description, quantity, unit_price, tax_rate, total_amount)
       VALUES ($1, $2, 'ZZ', 'ZZ goods', $3::numeric, 150, 0, $3::numeric * 150) RETURNING id`, [so, g.item, g.qty])).rows[0].id);
  }
  return { so, lines };
}
async function ship(c, so, soLine, item, qty) {
  const res = await request(appAs(c.id)).post('/warehouse/pick-lists').send({
    sales_order_id: so,
    lines: [{ item_id: item, item_name: `${TAG} Item`, bin_location_id: c.bin, bin_code: 'B', required_qty: qty, sales_order_item_id: soLine }],
  });
  const { rows: [line] } = await pool.query(`SELECT id FROM pick_list_lines WHERE pick_list_id = $1`, [res.body.id]);
  await request(appAs(c.id)).put(`/warehouse/pick-lists/${res.body.id}/pick`)
    .send({ lines: [{ line_id: line.id, picked_qty: qty, bin_location_id: c.bin, item_id: item }] }).expect(200);
  await request(appAs(c.id)).patch(`/warehouse/pick-lists/${res.body.id}/status`).send({ status: 'dispatched' }).expect(200);
  return { id: res.body.id, lineId: line.id };
}
async function invoicedTen(c) {
  const item = await makeItem(c);
  const { so, lines: [line] } = await makeOrder(c, [{ item, qty: 10 }]);
  const p = await ship(c, so, line, item, 10);
  const r = await request(appAs(c.id)).patch(`/sales/orders/${so}/invoice`).send({});
  const ii = await one(`SELECT id FROM invoice_items WHERE invoice_id = $1`, [r.body.invoice_id]);
  return { item, so, p, invoiceId: r.body.invoice_id, invoiceItemId: ii.id };
}
const credit = (c, body) => request(appAs(c.id)).post('/finance/credit-notes').send(body);

beforeAll(async () => {
  await sweep();
  await makeCompany('A');
  await makeCompany('B');
}, 60_000);
afterAll(async () => {
  await sweep();
}, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
describe('1. credit-note reason codes', () => {
  it('quantity_correction releases exactly what it credits, named line by line', async () => {
    const f = await invoicedTen(co.A);
    const base = { original_invoice_id: f.invoiceId, reason: 'quantity_correction', taxable_value: 300, total_amount: 300 };
    const cases = [
      [{ ...base }, 'QUANTITY_CORRECTION_LINES_REQUIRED'],
      [{ ...base, items: [{ quantity: 2, released_qty: 2 }] }, 'QUANTITY_CORRECTION_LINE_INVALID'],
      [{ ...base, items: [{ original_item_id: f.invoiceItemId, quantity: 2 }] }, 'QUANTITY_CORRECTION_LINE_INVALID'],
      [{ ...base, items: [{ original_item_id: f.invoiceItemId, quantity: 2, released_qty: 1 }] }, 'QUANTITY_CORRECTION_LINE_INVALID'],
    ];
    for (const [body, code] of cases) {
      const res = await credit(co.A, body);
      expect([code, res.status, res.body.code]).toEqual([code, 422, code]);
    }
    const ok = await credit(co.A, { ...base, items: [{ original_item_id: f.invoiceItemId, quantity: 2, released_qty: 2, unit_price: 150 }] });
    expect(ok.status).toBe(201);
    await request(appAs(co.A.id)).post(`/finance/credit-notes/${ok.body.data.id}/issue`).send({}).expect(200);
    expect(await num(`SELECT pick_line_invoiced_qty($1)::float`, [f.p.lineId])).toBe(8);
  });

  it("'other' and every price reason credit price only — in the API and the database", async () => {
    const f = await invoicedTen(co.A);
    for (const reason of ['other', 'price_revision', 'post_sale_discount', 'deficiency_of_service']) {
      const res = await credit(co.A, { original_invoice_id: f.invoiceId, reason, taxable_value: 1,
        items: [{ original_item_id: f.invoiceItemId, quantity: 1, released_qty: 1 }] });
      expect([reason, res.status, res.body.code]).toEqual([reason, 422, 'RELEASE_NOT_ALLOWED_FOR_REASON']);
    }
    const other = await credit(co.A, { original_invoice_id: f.invoiceId, reason: 'other', taxable_value: 1 });
    expect(other.status).toBe(201);                                       // a price-only 'other' note is still fine
    await expect(pool.query(`INSERT INTO credit_note_items (credit_note_id, original_item_id, quantity, released_qty) VALUES ($1, $2, 1, 1)`,
      [other.body.data.id, f.invoiceItemId])).rejects.toThrow(/credits price only/);
    // A quantity correction written around the API without matching lines is refused on issue.
    const qc = (await pool.query(
      `INSERT INTO credit_notes (credit_note_number, reason, company_id, original_invoice_id, taxable_value, total_amount)
       VALUES ($1, 'quantity_correction', $2, $3, 1, 1) RETURNING id`, [`${TAG}-CN-${++seq}`, co.A.id, f.invoiceId])).rows[0].id;
    await pool.query(`INSERT INTO credit_note_items (credit_note_id, original_item_id, quantity) VALUES ($1, $2, 1)`, [qc, f.invoiceItemId]);
    await expect(pool.query(`UPDATE credit_notes SET status = 'issued' WHERE id = $1`, [qc]))
      .rejects.toThrow(/releases exactly the quantity it credits/);
    // The amount-only sales credit route does not offer it.
    const viaSales = await request(appAs(co.A.id)).post('/sales/fulfilment/credit').send({ invoice_id: f.invoiceId, reason: 'quantity_correction', amount: 1 });
    expect(viaSales.status).toBe(400);
  });

  it('existing reasons are unchanged and the constraint accepts the new one', async () => {
    const { rows: [c] } = await pool.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'credit_notes_reason_check'`);
    for (const r of ['sales_return', 'quantity_correction', 'price_revision', 'deficiency_of_service', 'post_sale_discount', 'other']) {
      expect(c.d).toContain(`'${r}'`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('2. historical return receipts', () => {
  /** A return received through the API, then put back into its pre-3G shape
   *  (received, no received_qty) — the shape a historical row has. */
  async function legacyReturn(c, dispositions) {
    const items = await Promise.all(dispositions.map(() => makeItem(c)));
    const { so, lines } = await makeOrder(c, items.map(item => ({ item, qty: 5 })));
    for (let i = 0; i < items.length; i++) await ship(c, so, lines[i], items[i], 5);
    const r = (await request(appAs(c.id)).post('/scm/returns').send({ sales_order_id: so,
      lines: items.map(item => ({ item_id: item, quantity: 2 })) })).body;
    await request(appAs(c.id)).post(`/scm/returns/${r.id}/receive`).send({ lines: r.items.map((l, i) => ({ id: l.id, disposition: dispositions[i] })) }).expect(200);
    await pool.query(`UPDATE sales_return_items SET received_qty = NULL WHERE return_id = $1`, [r.id]);
    return { ...r, so };
  }
  const gaps = (c) => request(appAs(c.id)).get('/scm/returns/receipt-gaps');
  const correct = (c, r, lineId, body, perms = '*') =>
    request(appAs(c.id, perms)).post(`/scm/returns/${r.id}/lines/${lineId}/receipt-correction`).send(body);

  it('reports each gap with its evidence, never inferring from the requested quantity, and writes nothing', async () => {
    const r = await legacyReturn(co.A, ['restock', 'scrap']);
    const before = await num(`SELECT COUNT(*)::int FROM sales_return_items WHERE return_id = $1 AND received_qty IS NULL`, [r.id]);
    const res = await gaps(co.A);
    expect(res.status).toBe(200);
    const mine = res.body.lines.filter(l => l.return_id === r.id);
    expect(mine.map(l => [l.classification, l.proposed_received_qty])).toEqual([['verified_receipt', 2], ['unresolved', null]]);
    expect(res.body.summary).toMatchObject({ verified_non_receipt: 0 });
    expect(await num(`SELECT COUNT(*)::int FROM sales_return_items WHERE return_id = $1 AND received_qty IS NULL`, [r.id])).toBe(before);
    expect((await gaps(co.B)).body.lines.some(l => l.return_id === r.id)).toBe(false);
    const close = await request(appAs(co.A.id)).post(`/scm/returns/${r.id}/close`).send({});
    expect([close.status, close.body.code]).toEqual([409, 'RECEIPT_OUTSTANDING']);
  });

  it('a correction needs approval and evidence, must agree with it, fills one gap once, moves no stock, and lets the return close', async () => {
    const r = await legacyReturn(co.A, ['restock', 'scrap']);
    const [restockLine, scrapLine] = r.items.map(l => l.id);
    const stock = await num(`SELECT COUNT(*)::int FROM stock_ledger WHERE company_id = $1`, [co.A.id]);
    await correct(co.A, r, restockLine, { received_qty: 2, evidence_type: 'stock_ledger', evidence_reference: 'SL' }, ['sales:edit']).expect(403);
    const cases = [
      [restockLine, { received_qty: 2, evidence_type: 'stock_ledger' }, 422, 'EVIDENCE_REQUIRED'],
      [restockLine, { received_qty: 2, evidence_type: 'guess', evidence_reference: 'x' }, 422, 'EVIDENCE_TYPE_INVALID'],
      [restockLine, { received_qty: 1, evidence_type: 'stock_ledger', evidence_reference: 'SL' }, 422, 'RECEIVED_BELOW_RESTOCKED'],
      [restockLine, { received_qty: 3, evidence_type: 'receipt_document', evidence_reference: 'GRN-1' }, 422, 'RECEIVED_QTY_INVALID'],
      [scrapLine, { received_qty: 2, evidence_type: 'stock_ledger', evidence_reference: 'SL' }, 422, 'EVIDENCE_MISMATCH'],
    ];
    for (const [line, body, status, code] of cases) {
      const res = await correct(co.A, r, line, body);
      expect([code, res.status, res.body.code]).toEqual([code, status, code]);
    }
    await correct(co.B, r, restockLine, { received_qty: 2, evidence_type: 'stock_ledger', evidence_reference: 'SL' }).expect(404);
    expect(await num(`SELECT COUNT(*)::int FROM sales_return_receipt_corrections WHERE return_id = $1`, [r.id])).toBe(0);

    await correct(co.A, r, restockLine, { received_qty: 2, evidence_type: 'stock_ledger', evidence_reference: 'ledger: sales_return ' + r.id }).expect(200);
    const again = await correct(co.A, r, restockLine, { received_qty: 2, evidence_type: 'stock_ledger', evidence_reference: 'SL' });
    expect([again.status, again.body.code]).toEqual([409, 'NOT_A_RECEIPT_GAP']);
    await correct(co.A, r, scrapLine, { received_qty: 1, evidence_type: 'receipt_document', evidence_reference: 'Returns note RN-17', note: 'counted on arrival' }).expect(200);

    expect((await pool.query(`SELECT id, received_qty::float q FROM sales_return_items WHERE return_id = $1 ORDER BY id`, [r.id])).rows)
      .toEqual([{ id: restockLine, q: 2 }, { id: scrapLine, q: 1 }]);
    expect(await num(`SELECT COUNT(*)::int FROM stock_ledger WHERE company_id = $1`, [co.A.id])).toBe(stock);
    expect((await pool.query(`SELECT evidence_type, evidence_reference, corrected_by FROM sales_return_receipt_corrections WHERE return_id = $1 ORDER BY return_item_id`, [r.id])).rows)
      .toEqual([{ evidence_type: 'stock_ledger', evidence_reference: `ledger: sales_return ${r.id}`, corrected_by: 1 },
                { evidence_type: 'receipt_document', evidence_reference: 'Returns note RN-17', corrected_by: 1 }]);
    await expect.poll(async () => num(`SELECT COUNT(*)::int FROM audit_logs WHERE company_id = $1 AND action_type = 'receipt_correction'`, [co.A.id]),
      { timeout: 5000 }).toBe(2);
    await request(appAs(co.A.id)).post(`/scm/returns/${r.id}/close`).send({}).expect(200);
  });

  it('a non-receipt confirmation records 0, only where nothing was restocked', async () => {
    const r = await legacyReturn(co.A, ['restock', 'scrap']);
    const [restockLine, scrapLine] = r.items.map(l => l.id);
    const bad = await correct(co.A, r, restockLine, { received_qty: 0, evidence_type: 'non_receipt_confirmation', evidence_reference: 'Customer email' });
    expect([bad.status, bad.body.code]).toEqual([422, 'RECEIVED_BELOW_RESTOCKED']);
    await correct(co.A, r, scrapLine, { received_qty: 0, evidence_type: 'non_receipt_confirmation', evidence_reference: 'Carrier: parcel never collected' }).expect(200);
  });

  it('a line received under the current receipt is not a gap', async () => {
    const item = await makeItem(co.A);
    const { so, lines: [line] } = await makeOrder(co.A, [{ item, qty: 5 }]);
    await ship(co.A, so, line, item, 5);
    const r = (await request(appAs(co.A.id)).post('/scm/returns').send({ sales_order_id: so, lines: [{ item_id: item, quantity: 1 }] })).body;
    await request(appAs(co.A.id)).post(`/scm/returns/${r.id}/receive`).send({ lines: [{ id: r.items[0].id, disposition: 'scrap' }] }).expect(200);
    const res = await correct(co.A, r, r.items[0].id, { received_qty: 1, evidence_type: 'receipt_document', evidence_reference: 'x' });
    expect([res.status, res.body.code]).toEqual([409, 'NOT_A_RECEIPT_GAP']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('3. legacy order reconciliation', () => {
  it('classifies orders by their records, per company, writing nothing — and the safeguards still hold', async () => {
    const item = await makeItem(co.A);
    const legacy = await makeOrder(co.A, [{ item, qty: 4 }], 'completed');
    const partial = await makeOrder(co.A, [{ item, qty: 4 }], 'completed');
    const shippedOnly = await makeOrder(co.A, [{ item, qty: 2 }], 'dispatched');
    const nothing = await makeOrder(co.A, [{ item, qty: 1 }], 'delivered');
    const viaPick = await makeOrder(co.A, [{ item, qty: 1 }]);
    await ship(co.A, viaPick.so, viaPick.lines[0], item, 1);
    for (const [so, q] of [[legacy.so, 4], [partial.so, 3]]) {
      await pool.query(`INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, quantity_in, quantity_out, reference_type, reference_id,
                                                  transaction_date, company_id, remarks)
                        VALUES ($1, $2, 'dispatch', 0, $3, 'sales_order', $4, '2025-01-10', $5, 'legacy dispatch')`, [item, co.A.wh, q, so, co.A.id]);
    }
    await pool.query(`INSERT INTO shipments (company_id, reference_type, reference_id, sales_order_id, dispatch_ref, status, direction)
                      VALUES ($1, 'sales_order', $2, $2, $3, 'in_transit', 'outbound')`, [co.A.id, shippedOnly.so, `${TAG}-DSP-${++seq}`]);
    const footprint = async () => ({
      ledger: await num(`SELECT COUNT(*)::int FROM stock_ledger WHERE company_id = $1`, [co.A.id]),
      invoices: await num(`SELECT COUNT(*)::int FROM invoices WHERE company_id = $1`, [co.A.id]),
      returns: await num(`SELECT COUNT(*)::int FROM sales_returns WHERE company_id = $1`, [co.A.id]),
    });
    const before = await footprint();
    const res = await request(appAs(co.A.id)).get('/sales/orders/fulfilment-reconciliation');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.orders.map(o => [o.id, o]));
    expect([legacy.so, partial.so, shippedOnly.so, nothing.so].map(id => byId[id]?.classification)).toEqual(
      ['fulfilled_by_legacy_ledger', 'partially_recorded', 'shipped_without_stock_issue', 'no_fulfilment_record']);
    expect(byId[viaPick.so]).toBeUndefined();
    expect(byId[legacy.so].stock_lines).toEqual([expect.objectContaining({ item_id: item, ordered: 4, issued_via_order: 4 })]);
    expect(byId[legacy.so].recommended_action).toMatch(/Approve as legacy fulfilment/);
    expect(await footprint()).toEqual(before);
    expect((await request(appAs(co.B.id)).get('/sales/orders/fulfilment-reconciliation')).body.orders.some(o => o.id === legacy.so)).toBe(false);

    // Phase 3G safeguards still in force for each.
    for (const so of [legacy.so, shippedOnly.so]) {
      const inv = await request(appAs(co.A.id)).patch(`/sales/orders/${so}/invoice`).send({});
      expect([inv.status, inv.body.code]).toEqual([409, 'NOTHING_TO_INVOICE']);
      const ret = await request(appAs(co.A.id)).post('/scm/returns').send({ sales_order_id: so, lines: [{ item_id: item, quantity: 1 }] });
      expect([ret.status, ret.body.code]).toEqual([409, 'RETURN_NOT_FROM_STOCK']);
    }
    expect(await footprint()).toEqual(before);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('4. orphan-journal report', () => {
  it('runs read-only and reports a classification for every orphan', async () => {
    // The Phase 3I suite makes (and removes) fixture orphans of its own while
    // it runs; they are excluded on both sides so a concurrent run cannot
    // change what is compared.
    const FIXTURE = 'ZZI3I-JE-%';
    const count = () => num(`SELECT COUNT(*)::int FROM journal_entries je WHERE je.company_id IS NOT NULL
                              AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = je.company_id)
                              AND je.entry_number NOT LIKE $1`, [FIXTURE]);
    const before = await count();
    const outFile = resolve(here, `../../.orphan-report-${process.pid}.json`);
    try {
      execFileSync(process.execPath, [resolve(here, '../../scripts/reconciliation/orphan-journals-report.mjs'), '--json', outFile],
        { encoding: 'utf8', env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`report script failed (exit ${e.status}): ${String(e.stderr || '').slice(-800)}`);
    }
    const report = JSON.parse(readFileSync(outFile, 'utf8'));
    (await import('node:fs')).unlinkSync(outFile);
    const entries = report.entries.filter(e => !String(e.entry_number).startsWith('ZZI3I-JE-'));
    expect(entries.length).toBe(before);
    expect(report.entries.every(e => ['TEST_ARTEFACT', 'NEEDS_REVIEW'].includes(e.classification))).toBe(true);
    expect(Object.values(report.by_classification).reduce((t, v) => t + v.entries, 0)).toBe(report.total);
    expect(await count()).toBe(before);
  }, 60_000);
});

// ═════════════════════════════════════════════════════════════════════════════
describe('5. legacy fulfilment links (decision: link as reconciled)', () => {
  /** A completed order fulfilled by a legacy stock issue referencing it. */
  async function legacyOrder(c, qty = 4, { ledgerQty = qty } = {}) {
    const item = await makeItem(c);
    const { so, lines: [line] } = await makeOrder(c, [{ item, qty }], 'completed');
    const sl = (await pool.query(`INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, quantity_in, quantity_out, reference_type, reference_id,
                                                            transaction_date, company_id, remarks)
                                  VALUES ($1, $2, 'dispatch', 0, $3, 'sales_order', $4, '2025-01-10', $5, 'legacy dispatch') RETURNING id`,
      [item, c.wh, ledgerQty, so, c.id])).rows[0].id;
    return { item, so, line, sl };
  }
  const prefix = () => `${TAG}-SO-${co.A.id}-`;

  it('the database accepts only a link that matches its evidence, once, and never edits it', async () => {
    const o = await legacyOrder(co.A, 4);
    const other = await legacyOrder(co.A, 4);
    const ins = (vals) => pool.query(`INSERT INTO legacy_fulfilment_links (company_id, sales_order_item_id, stock_ledger_id, quantity, evidence, approved_by)
                                      VALUES ($1,$2,$3,$4,'x','QA') RETURNING id`, vals);
    await expect(ins([co.A.id, o.line, other.sl, 4])).rejects.toThrow(/not an issue referencing sales order/);
    await expect(ins([co.A.id, o.line, o.sl, 3])).rejects.toThrow(/must agree/);
    await expect(ins([co.B.id, o.line, o.sl, 4])).rejects.toThrow(/one company/);
    const { rows: [k] } = await ins([co.A.id, o.line, o.sl, 4]);
    await expect(ins([co.A.id, o.line, o.sl, 4])).rejects.toThrow(/ux_legacy_fulfilment/);
    await expect(pool.query(`UPDATE legacy_fulfilment_links SET quantity = 5 WHERE id = $1`, [k.id])).rejects.toThrow(/not edited/);
  });

  it('links exactly the verified orders, or nothing; no stock changes; the report shows them reconciled; invoicing and returns stay blocked', async () => {
    const good = await legacyOrder(co.A, 5);
    const short = await legacyOrder(co.A, 5, { ledgerQty: 4 });             // evidence disagrees: never linked
    const { candidates, rejected } = await links.candidates(pool, co.A.id, { orderNumberPrefix: prefix() });
    expect(candidates.map(c => c.sales_order_id)).toContain(good.so);
    expect(rejected.find(r => r.sales_order_id === short.so).reasons[0]).toMatch(/does not match the line/);
    const mine = candidates.filter(c => c.sales_order_id === good.so);

    const c = await pool.connect();
    try {
      // A plan that differs from what is eligible now links nothing.
      await expect(links.link(c, co.A.id, [...candidates, { ...mine[0], sales_order_item_id: -1 }], { approvedBy: 'QA', orderNumberPrefix: prefix() }))
        .rejects.toThrow(/differs from the expected set/);
      await expect(links.link(c, co.A.id, candidates, { orderNumberPrefix: prefix() })).rejects.toThrow(/approvedBy/);
      expect(await num(`SELECT COUNT(*)::int FROM legacy_fulfilment_links WHERE company_id = $1 AND sales_order_item_id = $2`, [co.A.id, good.line])).toBe(0);
      const stock = await num(`SELECT COALESCE(SUM(quantity_in - quantity_out), 0)::float FROM stock_ledger WHERE company_id = $1`, [co.A.id]);
      const r = await links.link(c, co.A.id, candidates, { approvedBy: 'QA reviewer', orderNumberPrefix: prefix() });
      expect(r.linked).toBe(candidates.length);
      expect(await num(`SELECT COALESCE(SUM(quantity_in - quantity_out), 0)::float FROM stock_ledger WHERE company_id = $1`, [co.A.id])).toBe(stock);
    } finally { c.release(); }

    const rep = await request(appAs(co.A.id)).get('/sales/orders/fulfilment-reconciliation');
    const byId = Object.fromEntries(rep.body.orders.map(o => [o.id, o]));
    expect(byId[good.so]).toMatchObject({ classification: 'reconciled_legacy_fulfilment' });
    expect(byId[good.so].stock_lines[0].legacy_link).toMatchObject({ stock_ledger_id: good.sl, quantity: 5, approved_by: 'QA reviewer' });
    expect(byId[short.so].classification).toBe('partially_recorded');
    const inv = await request(appAs(co.A.id)).patch(`/sales/orders/${good.so}/invoice`).send({});
    expect([inv.status, inv.body.code]).toEqual([409, 'NOTHING_TO_INVOICE']);
    const ret = await request(appAs(co.A.id)).post('/scm/returns').send({ sales_order_id: good.so, lines: [{ item_id: good.item, quantity: 1 }] });
    expect([ret.status, ret.body.code]).toEqual([409, 'RETURN_NOT_FROM_STOCK']);
    await expect.poll(async () => num(`SELECT COUNT(*)::int FROM audit_logs WHERE company_id = $1 AND action_type = 'legacy_fulfilment_linked' AND reference_id = $2`,
      [co.A.id, String(good.so)]), { timeout: 5000 }).toBe(1);
    // Linked once: a second run finds nothing left to link.
    expect((await links.candidates(pool, co.A.id, { orderNumberPrefix: prefix() })).candidates.some(x => x.sales_order_id === good.so)).toBe(false);
  });
});
