/**
 * integration.fulfilmentPhase3E.test.js — the final-inspection gate, invoicing
 * shipped goods, unpacking, and customer returns. Against the REAL database,
 * through the REAL routers.
 *
 * WHAT IS PROVED (Phase 3E)
 *   - QC gate: one gate on both dispatch paths. Passed, optional-pending and
 *     optional-unresolved dispatch; failed (mandatory or optional),
 *     mandatory-incomplete, mandatory-unresolved (the seed shape: result
 *     'SEED result ', status 'active'), FAT in progress / on hold / failed,
 *     open punch points and a missing customer witness block — each as a 409
 *     FAT_GATE listing its blockers, with nothing written. The two FAT
 *     settings switch exactly their own check; the gate switch turns all off;
 *     a cancelled production order or test is ignored; sales-order `force`
 *     does not bypass it.
 *   - Invoicing shipped goods: a line names the dispatched pick-list line it
 *     bills; partial invoicing up to the picked quantity, never beyond (also
 *     under concurrency); COGS at the pick's FIFO cost (caller cost ignored);
 *     no stock movement; every refusal (duplicate, not dispatched, other
 *     company, other order, other item, unverified cost) writes nothing; the
 *     database trigger refuses the same over-billing written directly.
 *   - Unpack: restores each serial to exactly its pre-pack state (also after a
 *     double pack), keeps packages as 'unpacked' history, moves no stock;
 *     refuses — writing nothing — a serial moved since packing, a line packed
 *     before prior state was recorded, a package on a unit load; packed lists
 *     still cannot be cancelled until unpacked; an unpacked package is never
 *     shipped.
 *   - Returns: restock only what left stock for the order through a dispatched
 *     pick list, at the cost it left at, into the warehouse it left from; never
 *     beyond (also under concurrency); serial and SO-level-dispatch returns
 *     refused for restock; received_qty restocked only when stock moved;
 *     tenancy on create, receive and close.
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
import { randomUUID } from 'node:crypto';

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

const { default: pool }            = await import('../config/db.js');
const { default: warehouseRouter } = await import('../modules/warehouse/warehouse.routes.js');
const { default: salesRouter }     = await import('../modules/sales/routes/sales.routes.js');
const { default: financeRouter }   = await import('../modules/finance/routes/finance.routes.js');
const { default: scmRouter }       = await import('../modules/logistics/scmPlanning.routes.js');
const { postStock }                = await import('../modules/production/subcontracting.routes.js');

const TAG = 'ZZP3E';

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
  app.use('/scm', scmRouter);
  return app;
}

const co = {};
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
const num = async (sql, params = []) => Number(Object.values((await pool.query(sql, params)).rows[0])[0]);

// ── cleanup ──────────────────────────────────────────────────────────────────
async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  const items = `(SELECT id FROM inventory_items WHERE company_id = ANY($1))`;
  const steps = [
    `DELETE FROM sales_return_items WHERE company_id = ANY($1)`,
    `DELETE FROM sales_returns WHERE company_id = ANY($1)`,
    `DELETE FROM credit_notes WHERE company_id = ANY($1)`,
    `DELETE FROM inventory_fifo_consumption WHERE item_id IN ${items}`,
    `DELETE FROM inventory_fifo_layers WHERE item_id IN ${items}`,
    `DELETE FROM stock_ledger WHERE item_id IN ${items}`,
    `DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id = ANY($1))`,
    `DELETE FROM invoices WHERE company_id = ANY($1)`,
    `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE company_id = ANY($1))`,
    `DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id = ANY($1))`,
    `DELETE FROM journal_entries WHERE company_id = ANY($1)`,
    `UPDATE serial_numbers SET package_id = NULL, shipment_id = NULL WHERE company_id = ANY($1)`,
    `DELETE FROM package_lines WHERE company_id = ANY($1)`,
    `DELETE FROM packages WHERE company_id = ANY($1)`,
    `DELETE FROM unit_loads WHERE company_id = ANY($1)`,
    `DELETE FROM shipments WHERE company_id = ANY($1)`,
    `DELETE FROM pick_list_lines WHERE pick_list_id IN (SELECT id FROM pick_lists WHERE company_id = ANY($1))`,
    `DELETE FROM pick_lists WHERE company_id = ANY($1)`,
    `DELETE FROM serial_numbers WHERE company_id = ANY($1)`,
    `DELETE FROM punch_points WHERE test_run_id IN (SELECT id FROM test_runs WHERE company_id = ANY($1))`,
    `DELETE FROM test_runs WHERE company_id = ANY($1)`,
    `DELETE FROM quality_tests WHERE production_order_id IN (SELECT id FROM production_orders WHERE company_id = ANY($1))`,
    `DELETE FROM production_orders WHERE company_id = ANY($1)`,
    `DELETE FROM sales_order_items WHERE order_id IN (SELECT id FROM sales_orders WHERE company_id = ANY($1))`,
    `DELETE FROM sales_orders WHERE company_id = ANY($1)`,
    `DELETE FROM parties WHERE company_id = ANY($1)`,
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

// ── fixtures ─────────────────────────────────────────────────────────────────
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

/**
 * A fresh item with FIFO cost layers (each [qty, unit_cost]) posted through
 * postStock, the way receipts open layers — or, with layered: false, opening
 * stock written straight to the ledger with no layer (stock that predates
 * layering, whose cost cannot be verified).
 */
async function makeItem(c, layers = [[6, 80], [200, 120]], { layered = true } = {}) {
  seq++;
  const item = (await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, standard_cost)
     VALUES ($1, $2, $3, 'NOS', 100) RETURNING id`, [`${TAG}-${c.id}-I${seq}`, `${TAG} Item ${seq}`, c.id])).rows[0].id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [qty, rate] of layers) {
      if (layered) {
        await postStock(client, { itemId: item, warehouseId: c.wh, inQty: qty, rate, txnType: 'opening',
          refType: 'opening', refId: null, remarks: `${TAG} opening`, companyId: c.id, transactionDate: '2026-09-01' });
      } else {
        await client.query(
          `INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, quantity_in, quantity_out, rate,
                                     transaction_date, company_id, remarks)
           VALUES ($1, $2, 'opening', $3, 0, $4, '2026-09-01', $5, $6)`, [item, c.wh, qty, rate, c.id, `${TAG} opening`]);
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return item;
}

async function makeSalesOrder(c, { customerId = null } = {}) {
  seq++;
  const so = (await pool.query(
    `INSERT INTO sales_orders (order_number, company_id, customer_name, customer_id, order_status, subtotal, tax_amount, total_amount)
     VALUES ($1, $2, 'ZZ Customer', $3, 'confirmed', 1000, 0, 1000) RETURNING id`,
    [`${TAG}-SO-${c.id}-${seq}`, c.id, customerId])).rows[0].id;
  await pool.query(
    `INSERT INTO sales_order_items (order_id, item_code, description, quantity, unit_price, tax_rate, total_amount)
     VALUES ($1, 'ZZ', 'ZZ goods', 10, 100, 0, 1000)`, [so]);
  return so;
}

async function makePickList(c, item, so, requiredQty = 10) {
  const res = await request(appAs(c.id)).post('/warehouse/pick-lists').send({
    sales_order_id: so,
    lines: [{ item_id: item, item_name: `${TAG} Item`, bin_location_id: c.bin, bin_code: 'B', required_qty: requiredQty }],
  });
  expect(res.status).toBe(201);
  const { rows: [line] } = await pool.query(`SELECT id FROM pick_list_lines WHERE pick_list_id = $1`, [res.body.id]);
  return { id: res.body.id, lineId: line.id };
}
const pick = (c, pl, item, qty) => request(appAs(c.id)).put(`/warehouse/pick-lists/${pl.id}/pick`)
  .send({ lines: [{ line_id: pl.lineId, picked_qty: qty, bin_location_id: c.bin, item_id: item, item_name: `${TAG} Item` }] });
const setStatus = (c, pl, status, perms = '*') =>
  request(appAs(c.id, perms)).patch(`/warehouse/pick-lists/${pl.id}/status`).send({ status });

/** Item + order + pick list, picked and dispatched: goods that have left. */
async function shipped(c, qty = 10, opts = {}) {
  const item = await makeItem(c, opts.layers, opts);
  const so = await makeSalesOrder(c);
  const pl = await makePickList(c, item, so, qty);
  await pick(c, pl, item, qty).expect(200);
  await setStatus(c, pl, 'dispatched').expect(200);
  return { item, so, pl };
}

const stockRows = (item) => num(`SELECT COUNT(*)::int FROM stock_ledger WHERE item_id = $1`, [item]);
const onHand = (item) => num(`SELECT COALESCE(SUM(quantity_in - quantity_out), 0)::float FROM stock_ledger WHERE item_id = $1`, [item]);

beforeAll(async () => {
  await sweep();
  await makeCompany('A');
  await makeCompany('B');
}, 60_000);
afterAll(async () => {
  await sweep();
}, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
describe('final-inspection dispatch gate', () => {
  async function qcOrder(c) {
    const item = await makeItem(c, [[50, 100]]);
    const so = await makeSalesOrder(c);
    seq++;
    const po = (await pool.query(
      `INSERT INTO production_orders (production_order_no, product_name, quantity_planned, status, sales_order_id, company_id)
       VALUES ($1, 'ZZ product', 1, 'released', $2, $3) RETURNING id`, [`${TAG}-PO-${seq}`, so, c.id])).rows[0].id;
    const pl = await makePickList(c, item, so, 2);
    await pick(c, pl, item, 2).expect(200);
    return { item, so, po, pl };
  }
  const addTest = (c, po, { result = 'pass', status = 'completed', mandatory = true } = {}) => pool.query(
    `INSERT INTO quality_tests (source_type, test_name, production_order_id, result, status, is_mandatory, company_id)
     VALUES ('production', 'ZZ test', $1, $2, $3, $4, $5) RETURNING id`, [po, result, status, mandatory, c.id]).then(r => r.rows[0].id);
  const addRun = (c, po, { result = 'pass', witness = null, status = 'completed' } = {}) => pool.query(
    `INSERT INTO test_runs (production_order_id, test_stage, test_type, overall_result, status, customer_witness, company_id)
     VALUES ($1, 'FAT', 'functional', $2, $3, $4, $5) RETURNING id`, [po, result, status, witness, c.id]).then(r => r.rows[0].id);
  const addPunch = (c, run, status = 'open') => pool.query(
    `INSERT INTO punch_points (test_run_id, description, status, company_id) VALUES ($1, 'ZZ punch', $2, $3)`, [run, status, c.id]);
  const settings = async (c, s) => {
    await pool.query(`DELETE FROM quality_settings WHERE company_id = $1`, [c.id]);
    if (s) {
      await pool.query(
        `INSERT INTO quality_settings (company_id, fat_dispatch_gate, fat_punch_point_closure_req, fat_customer_witness_req)
         VALUES ($1, $2, $3, $4)`, [c.id, s.gate ?? true, s.punch ?? true, s.witness ?? false]);
    }
  };
  const dispatch = (c, f) => request(appAs(c.id)).post('/warehouse/dispatch').send({ pick_list_id: f.pl.id, courier: 'ZZ' });
  const snapshot = async (f) => ({
    list: (await one(`SELECT status FROM pick_lists WHERE id = $1`, [f.pl.id])).status,
    order: (await one(`SELECT order_status FROM sales_orders WHERE id = $1`, [f.so])).order_status,
    shipments: await num(`SELECT COUNT(*)::int FROM shipments WHERE sales_order_id = $1`, [f.so]),
  });
  async function expectBlocked(c, f, kinds) {
    const before = await snapshot(f);
    const res = await dispatch(c, f);
    expect([res.status, res.body.code]).toEqual([409, 'FAT_GATE']);
    expect(res.body.blockers.map(b => b.kind).sort()).toEqual([...kinds].sort());
    expect(await snapshot(f)).toEqual(before);
    return res;
  }

  it('dispatches when every test passed and the FAT passed with its punch points closed', async () => {
    await settings(co.A, null);
    const f = await qcOrder(co.A);
    await addTest(co.A, f.po);
    const run = await addRun(co.A, f.po);
    await addPunch(co.A, run, 'closed');
    await addPunch(co.A, run, 'waived');
    const res = await dispatch(co.A, f);
    expect(res.status).toBe(200);
    expect((await snapshot(f)).shipments).toBe(1);
  });

  it('a failed test blocks — mandatory or optional', async () => {
    const f = await qcOrder(co.A);
    await addTest(co.A, f.po, { result: 'fail', mandatory: true });
    await addTest(co.A, f.po, { result: 'fail', mandatory: false });
    await expectBlocked(co.A, f, ['FAILED', 'FAILED']);
  });

  it('a mandatory test still pending blocks as INCOMPLETE; an optional one does not', async () => {
    const f = await qcOrder(co.A);
    await addTest(co.A, f.po, { result: 'pending', status: 'open', mandatory: true });
    await addTest(co.A, f.po, { result: 'pending', status: 'open', mandatory: false });
    const res = await expectBlocked(co.A, f, ['INCOMPLETE']);
    expect(res.body.blockers[0].source).toBe('quality_test');

    const g = await qcOrder(co.A);
    await addTest(co.A, g.po, { result: 'pending', status: 'open', mandatory: false });
    expect((await dispatch(co.A, g)).status).toBe(200);
  });

  it("the seed shape (result 'SEED result ', status 'active') is UNRESOLVED, never a pass, when mandatory", async () => {
    const f = await qcOrder(co.A);
    await addTest(co.A, f.po, { result: 'SEED result ', status: 'active', mandatory: true });
    await expectBlocked(co.A, f, ['UNRESOLVED']);

    const g = await qcOrder(co.A);
    await addTest(co.A, g.po, { result: 'SEED result ', status: 'active', mandatory: false });
    expect((await dispatch(co.A, g)).status).toBe(200);
  });

  it('a FAT in progress or on hold is INCOMPLETE; a failed FAT is FAILED', async () => {
    const f = await qcOrder(co.A);
    await addRun(co.A, f.po, { result: 'in_progress', status: 'in_progress' });
    await addRun(co.A, f.po, { result: 'hold' });
    await addRun(co.A, f.po, { result: 'fail' });
    const res = await expectBlocked(co.A, f, ['INCOMPLETE', 'INCOMPLETE', 'FAILED']);
    expect(res.body.blockers.every(b => b.source === 'test_run')).toBe(true);
  });

  it('open punch points block a passed FAT only while fat_punch_point_closure_req is on', async () => {
    const f = await qcOrder(co.A);
    const run = await addRun(co.A, f.po);
    await addPunch(co.A, run, 'open');
    await addPunch(co.A, run, 'in_progress');
    await settings(co.A, null);                              // no settings row: default on
    await expectBlocked(co.A, f, ['OPEN_PUNCH_POINTS']);
    await settings(co.A, { punch: false });
    expect((await dispatch(co.A, f)).status).toBe(200);
    await settings(co.A, null);
  });

  it('a missing customer witness blocks only while fat_customer_witness_req is on', async () => {
    await settings(co.A, { witness: true });
    const f = await qcOrder(co.A);
    await addRun(co.A, f.po, { witness: '' });
    await expectBlocked(co.A, f, ['WITNESS_MISSING']);

    const g = await qcOrder(co.A);
    await addRun(co.A, g.po, { witness: 'Customer QA — R. Iyer' });
    expect((await dispatch(co.A, g)).status).toBe(200);

    await settings(co.A, null);                              // default off
    const h = await qcOrder(co.A);
    await addRun(co.A, h.po, { witness: null });
    expect((await dispatch(co.A, h)).status).toBe(200);
  });

  it('turning the gate off turns every check off, for that company only', async () => {
    await settings(co.B, { gate: false });
    const fb = await qcOrder(co.B);
    await addTest(co.B, fb.po, { result: 'fail' });
    expect((await dispatch(co.B, fb)).status).toBe(200);

    await settings(co.A, null);
    const fa = await qcOrder(co.A);
    await addTest(co.A, fa.po, { result: 'fail' });
    await expectBlocked(co.A, fa, ['FAILED']);
    await settings(co.B, null);
  });

  it('a cancelled production order, test or FAT run does not block', async () => {
    const f = await qcOrder(co.A);
    await addTest(co.A, f.po, { result: 'fail', status: 'cancelled' });
    await addRun(co.A, f.po, { result: 'fail', status: 'cancelled' });
    seq++;
    const deadPo = (await pool.query(
      `INSERT INTO production_orders (production_order_no, product_name, quantity_planned, status, sales_order_id, company_id)
       VALUES ($1, 'ZZ product', 1, 'cancelled', $2, $3) RETURNING id`, [`${TAG}-PO-${seq}`, f.so, co.A.id])).rows[0].id;
    await addTest(co.A, deadPo, { result: 'fail' });
    expect((await dispatch(co.A, f)).status).toBe(200);
  });

  it('sales-order dispatch runs the same gate, and force does not bypass it', async () => {
    const f = await qcOrder(co.A);
    // The pick list must be closed for sales-order dispatch: cancel it (stock returns).
    await setStatus(co.A, f.pl, 'cancelled').expect(200);
    await addTest(co.A, f.po, { result: 'pending', status: 'open' });
    const before = await snapshot(f);
    const res = await request(appAs(co.A.id)).put(`/sales/orders/${f.so}/dispatch`).send({ carrier: 'ZZ', force: true });
    expect([res.status, res.body.code]).toEqual([409, 'FAT_GATE']);
    expect(res.body.blockers.map(b => b.kind)).toEqual(['INCOMPLETE']);
    expect(await snapshot(f)).toEqual(before);

    await pool.query(`UPDATE quality_tests SET result = 'pass', status = 'completed' WHERE production_order_id = $1`, [f.po]);
    const ok = await request(appAs(co.A.id)).put(`/sales/orders/${f.so}/dispatch`).send({ carrier: 'ZZ', force: true });
    expect(ok.status).toBe(200);
    expect(ok.body.dispatch_ref).toMatch(/^DSP-\d{6}$/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('invoicing shipped goods', () => {
  const invoice = (c, so, items, extra = {}) => request(appAs(c.id)).post('/finance/invoices').send({
    invoice_date: '2026-10-27', due_date: '2026-11-26', subtotal: 100, tax_amount: 0, total_amount: 100,
    sales_order_id: so, items, ...extra,
  });
  const line = (pl, quantity, extra = {}) =>
    ({ description: 'ZZ goods', quantity, unit_price: 150, amount: quantity * 150, pick_list_line_id: pl.lineId, ...extra });
  const billed = (pl) => num(`SELECT COALESCE(SUM(quantity), 0)::float FROM invoice_items WHERE pick_list_line_id = $1`, [pl.lineId]);
  const cogs = (invId) => one(`
    SELECT COUNT(DISTINCT e.id)::int AS entries,
           COALESCE(SUM(l.debit), 0)::float AS debit, COALESCE(SUM(l.credit), 0)::float AS credit
      FROM journal_entries e LEFT JOIN journal_lines l ON l.entry_id = e.id
     WHERE e.entry_type = 'COGS' AND e.reference_type = 'invoice' AND e.reference_id::text = $1::text`, [invId]);
  const companyTotals = async (c) => ({
    invoices: await num(`SELECT COUNT(*)::int FROM invoices WHERE company_id = $1`, [c.id]),
    lines: await num(`SELECT COUNT(*)::int FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.company_id = $1`, [c.id]),
    journals: await num(`SELECT COUNT(*)::int FROM journal_entries WHERE company_id = $1`, [c.id]),
  });

  it('bills part of a shipment at the FIFO cost it left at, moves no stock, and links the order', async () => {
    // 10 picked: 6 from the layer at 80, 4 from the layer at 120 → 960, 96 a unit.
    const { item, so, pl } = await shipped(co.A, 10);
    const rowsBefore = await stockRows(item);
    const res = await invoice(co.A, so, [line(pl, 4, { unit_cost: 1, item_id: item })]);
    expect(res.status).toBe(201);
    const [stored] = (await pool.query(`SELECT item_id, pick_list_line_id, unit_cost, quantity FROM invoice_items WHERE invoice_id = $1`, [res.body.id])).rows;
    expect({ item: stored.item_id, pick: stored.pick_list_line_id, cost: Number(stored.unit_cost), qty: Number(stored.quantity) })
      .toEqual({ item, pick: pl.lineId, cost: 96, qty: 4 });             // the caller's unit_cost 1 is ignored
    expect(await cogs(res.body.id)).toEqual({ entries: 1, debit: 384, credit: 384 });     // 4 × 96, balanced
    expect(await stockRows(item)).toBe(rowsBefore);
    expect((await one(`SELECT sales_order_id FROM invoices WHERE id = $1`, [res.body.id])).sales_order_id).toBe(so);

    // The rest can be billed; nothing beyond it.
    expect((await invoice(co.A, so, [line(pl, 6)])).status).toBe(201);
    const before = await companyTotals(co.A);
    const over = await invoice(co.A, so, [line(pl, 1)]);
    expect([over.status, over.body.code]).toEqual([409, 'FULFILMENT_OVER_INVOICED']);
    expect(await companyTotals(co.A)).toEqual(before);
    expect(await billed(pl)).toBe(10);
    expect(await stockRows(item)).toBe(rowsBefore);
  });

  it('two simultaneous invoices for the same goods: exactly one is billed', async () => {
    const { so, pl } = await shipped(co.A, 10);
    const results = await Promise.all([invoice(co.A, so, [line(pl, 7)]), invoice(co.A, so, [line(pl, 7)])]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(results.find(r => r.status === 409).body.code).toBe('FULFILMENT_OVER_INVOICED');
    expect(await billed(pl)).toBe(7);
  });

  it('refuses, writing nothing: a duplicated line, an undispatched list, another order, another item, no order', async () => {
    const { item, so, pl } = await shipped(co.A, 10);
    const other = await makeItem(co.A);
    const otherSo = await makeSalesOrder(co.A);
    const picked = await makePickList(co.A, item, so, 3);
    await pick(co.A, picked, item, 3).expect(200);                          // picked, not dispatched
    const before = await companyTotals(co.A);
    const cases = [
      [invoice(co.A, so, [line(pl, 1), line(pl, 1)]), 422, 'FULFILMENT_LINE_DUPLICATED'],
      [invoice(co.A, so, [line(picked, 1)]), 409, 'FULFILMENT_NOT_DISPATCHED'],
      [invoice(co.A, otherSo, [line(pl, 1)]), 422, 'FULFILMENT_ORDER_MISMATCH'],
      [invoice(co.A, so, [line(pl, 1, { item_id: other })]), 422, 'FULFILMENT_ITEM_MISMATCH'],
      [invoice(co.A, null, [line(pl, 1)]), 422, 'SALES_ORDER_REQUIRED'],
      [invoice(co.A, so, [line(pl, 0)]), 422, 'FULFILMENT_QUANTITY_INVALID'],
      [invoice(co.A, so, [{ description: 'goods', quantity: 1, unit_price: 1, amount: 1, item_id: item }]), 422, 'STOCK_LINE_REQUIRES_FULFILMENT'],
    ];
    for (const [p, status, code] of cases) {
      const res = await p;
      expect([code, res.status, res.body.code]).toEqual([code, status, code]);
    }
    expect(await companyTotals(co.A)).toEqual(before);
    expect(await billed(pl)).toBe(0);
  });

  it("another company's pick line is not found, and its goods stay unbilled", async () => {
    const a = await shipped(co.A, 5);
    const soB = await makeSalesOrder(co.B);
    const before = await companyTotals(co.B);
    const res = await invoice(co.B, soB, [line(a.pl, 1)]);
    expect([res.status, res.body.code]).toEqual([404, 'FULFILMENT_LINE_NOT_FOUND']);
    expect(await companyTotals(co.B)).toEqual(before);
    expect(await billed(a.pl)).toBe(0);
  });

  it('goods whose cost cannot be verified from FIFO are not invoiced (no COGS can be posted)', async () => {
    const { so, pl } = await shipped(co.A, 4, { layers: [[50, 100]], layered: false });
    const before = await companyTotals(co.A);
    const res = await invoice(co.A, so, [line(pl, 4)]);
    expect([res.status, res.body.code]).toEqual([422, 'FULFILMENT_COST_UNVERIFIED']);
    expect(await companyTotals(co.A)).toEqual(before);
  });

  it('the database refuses over-billing written around the service', async () => {
    const { so, pl } = await shipped(co.A, 3);
    const inv = await invoice(co.A, so, [line(pl, 3)]);
    expect(inv.status).toBe(201);
    await expect(pool.query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount, pick_list_line_id)
       VALUES ($1, 'sneak', 1, 1, 1, $2)`, [inv.body.id, pl.lineId])).rejects.toThrow();
    expect(await billed(pl)).toBe(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('unpacking a packed pick list', () => {
  /** A picked list whose one line is a serialised unit in a known state. */
  async function serialList(c, prior = {}) {
    const item = await makeItem(c, [[20, 100]]);
    const party = (await pool.query(
      `INSERT INTO parties (party_code, party_type, name, company_id) VALUES ($1, 'customer', 'ZZ Party', $2) RETURNING id`,
      [`${TAG}-P-${++seq}`, c.id])).rows[0].id;
    const so = await makeSalesOrder(c, { customerId: party });
    const pl = await makePickList(c, item, so, 1);
    const priorCustomer = prior.customer === undefined ? randomUUID() : prior.customer;
    const serial = (await pool.query(
      `INSERT INTO serial_numbers (serial_number, item_id, status, customer_id, company_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [`${TAG}-SN-${++seq}`, item, prior.status ?? 'in_stock', priorCustomer, c.id])).rows[0].id;
    await pool.query(`UPDATE pick_list_lines SET serial_id = $2 WHERE id = $1`, [pl.lineId, serial]);
    await pick(c, pl, item, 1).expect(200);
    return { item, so, pl, serial, party, priorCustomer };
  }
  const serialState = async (id) => {
    const s = await one(`SELECT status, package_id, customer_id FROM serial_numbers WHERE id = $1`, [id]);
    return { status: s.status, package_id: s.package_id, customer_id: s.customer_id };
  };
  const unpack = (c, pl, perms = '*') => request(appAs(c.id, perms)).post(`/warehouse/pick-lists/${pl.id}/unpack`).send({});
  const packageStates = async (pl) => (await pool.query(
    `SELECT status, shipment_id FROM packages WHERE pick_list_id = $1 ORDER BY id`, [pl.id])).rows;

  it('restores the serial exactly, keeps the package as history, moves no stock — then the list can be cancelled', async () => {
    const f = await serialList(co.A);
    const original = await serialState(f.serial);
    const rows = await stockRows(f.item);
    await setStatus(co.A, f.pl, 'packed').expect(200);
    const packed = await serialState(f.serial);
    expect(packed.status).toBe('packed');
    expect(packed.customer_id).toBe(f.party);                         // packing overwrote all three
    const recorded = await one(
      `SELECT serial_prior_status, serial_prior_package_id, serial_prior_customer_id, serial_prior_recorded
         FROM package_lines WHERE serial_id = $1`, [f.serial]);
    expect(recorded).toEqual({ serial_prior_status: 'in_stock', serial_prior_package_id: null,
                               serial_prior_customer_id: f.priorCustomer, serial_prior_recorded: true });

    // Packed: still not cancellable.
    const refused = await setStatus(co.A, f.pl, 'cancelled');
    expect([refused.status, refused.body.code]).toEqual([409, 'PACKED_NOT_CANCELLABLE']);

    const res = await unpack(co.A, f.pl);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'completed', packages_unpacked: 1, serials_restored: 1 });
    expect(await serialState(f.serial)).toEqual(original);
    const [pkg] = await pool.query(`SELECT status, unpacked_at, unpacked_by FROM packages WHERE pick_list_id = $1`, [f.pl.id]).then(r => r.rows);
    expect(pkg.status).toBe('unpacked');
    expect(pkg.unpacked_at).not.toBeNull();
    expect(pkg.unpacked_by).toBe(1);
    expect(await stockRows(f.item)).toBe(rows);                       // packing and unpacking moved nothing

    const onHandBefore = await onHand(f.item);
    await setStatus(co.A, f.pl, 'cancelled').expect(200);
    expect(await onHand(f.item)).toBe(onHandBefore + 1);              // returned once
  });

  it('a serial is in one live package at a time; after unpack it re-packs, and unpacks back to the original', async () => {
    const f = await serialList(co.A, { status: 'active', customer: null });
    const original = await serialState(f.serial);
    await request(appAs(co.A.id)).post('/warehouse/pack').send({ pick_list_id: f.pl.id }).expect(201);
    const first = await serialState(f.serial);
    // A second pack has nothing left to pack (Phase 3F: packing is idempotent)
    // and writes nothing; the database would refuse the same unit in a second
    // live package anyway (uq_package_lines_serial_live).
    const twice = await request(appAs(co.A.id)).post('/warehouse/pack').send({ pick_list_id: f.pl.id });
    expect([twice.status, twice.body.already_packed]).toEqual([200, true]);
    expect(await serialState(f.serial)).toEqual(first);
    expect(await packageStates(f.pl)).toEqual([{ status: 'packed', shipment_id: null }]);

    await unpack(co.A, f.pl).expect(200);
    expect(await serialState(f.serial)).toEqual(original);
    await request(appAs(co.A.id)).post('/warehouse/pack').send({ pick_list_id: f.pl.id }).expect(201);
    expect((await serialState(f.serial)).status).toBe('packed');
    const res = await unpack(co.A, f.pl);
    expect(res.body).toMatchObject({ packages_unpacked: 1, serials_restored: 1 });
    expect(await serialState(f.serial)).toEqual(original);
    expect(await packageStates(f.pl)).toEqual([{ status: 'unpacked', shipment_id: null }, { status: 'unpacked', shipment_id: null }]);
    expect(await num(`SELECT COUNT(*)::int FROM package_lines WHERE serial_id = $1 AND NOT unpacked`, [f.serial])).toBe(0);
  });

  it('refuses, writing nothing, when a serial has moved since packing', async () => {
    const f = await serialList(co.A);
    await setStatus(co.A, f.pl, 'packed').expect(200);
    await pool.query(`UPDATE serial_numbers SET status = 'scrapped' WHERE id = $1`, [f.serial]);
    const moved = await serialState(f.serial);
    const res = await unpack(co.A, f.pl);
    expect([res.status, res.body.code]).toEqual([409, 'SERIAL_STATE_CHANGED']);
    expect(await serialState(f.serial)).toEqual(moved);
    expect(await packageStates(f.pl)).toEqual([{ status: 'packed', shipment_id: null }]);
    expect((await one(`SELECT status FROM pick_lists WHERE id = $1`, [f.pl.id])).status).toBe('packed');
  });

  it('refuses a serial line packed before its prior state was recorded', async () => {
    const f = await serialList(co.A);
    await setStatus(co.A, f.pl, 'packed').expect(200);
    await pool.query(
      `UPDATE package_lines SET serial_prior_recorded = false, serial_prior_status = NULL WHERE serial_id = $1`, [f.serial]);
    const res = await unpack(co.A, f.pl);
    expect([res.status, res.body.code]).toEqual([409, 'PACK_STATE_UNRECORDED']);
    expect((await serialState(f.serial)).status).toBe('packed');
    expect(await packageStates(f.pl)).toEqual([{ status: 'packed', shipment_id: null }]);
  });

  it('refuses a package that sits on a unit load', async () => {
    const f = await serialList(co.A);
    await setStatus(co.A, f.pl, 'packed').expect(200);
    const ul = (await pool.query(`INSERT INTO unit_loads (company_id) VALUES ($1) RETURNING id`, [co.A.id])).rows[0].id;
    await pool.query(`UPDATE packages SET unit_load_id = $2 WHERE pick_list_id = $1`, [f.pl.id, ul]);
    const res = await unpack(co.A, f.pl);
    expect([res.status, res.body.code]).toEqual([409, 'PACKAGE_ON_UNIT_LOAD']);
    expect((await serialState(f.serial)).status).toBe('packed');
  });

  it('only a packed list unpacks; an unpacked package is never shipped', async () => {
    const f = await serialList(co.A);
    const notPacked = await unpack(co.A, f.pl);
    expect([notPacked.status, notPacked.body.code]).toEqual([409, 'NOT_PACKED']);
    await setStatus(co.A, f.pl, 'packed').expect(200);
    await unpack(co.A, f.pl).expect(200);
    const res = await request(appAs(co.A.id)).post('/warehouse/dispatch').send({ pick_list_id: f.pl.id, courier: 'ZZ' });
    expect(res.status).toBe(200);
    expect(res.body.packages).toBe(0);
    expect(await packageStates(f.pl)).toEqual([{ status: 'unpacked', shipment_id: null }]);
  });

  it("another company cannot unpack; a view-only caller is refused", async () => {
    const f = await serialList(co.A);
    await setStatus(co.A, f.pl, 'packed').expect(200);
    await unpack(co.B, f.pl).expect(404);
    await unpack(co.A, f.pl, ['inventory:view']).expect(403);
    expect((await serialState(f.serial)).status).toBe('packed');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('customer returns', () => {
  const raise = (c, so, lines, extra = {}) =>
    request(appAs(c.id)).post('/scm/returns').send({ sales_order_id: so, reason: 'ZZ', lines, ...extra });
  const receive = (c, ret, lines) => request(appAs(c.id)).post(`/scm/returns/${ret}/receive`).send({ lines });
  const returnLedger = (ret) => pool.query(
    `SELECT item_id, warehouse_id, quantity_in::float AS q, rate::float AS rate FROM stock_ledger
      WHERE reference_type = 'sales_return' AND reference_id = $1`, [ret]).then(r => r.rows);
  async function rma(c, so, item, qty, extra = {}) {
    const res = await raise(c, so, [{ item_id: item, item_name: 'ZZ', quantity: qty, unit_price: 150, ...extra }]);
    expect(res.status).toBe(201);
    return { id: res.body.id, lineId: res.body.items[0].id };
  }

  it('restocks what left for the order, at the cost it left at, into the warehouse it left from', async () => {
    const { item, so } = await shipped(co.A, 10);                     // left at 96 a unit
    const r = await rma(co.A, so, item, 3);
    const res = await receive(co.A, r.id, [{ id: r.lineId, disposition: 'restock' }]);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('received');
    expect(await returnLedger(r.id)).toEqual([{ item_id: item, warehouse_id: co.A.wh, q: 3, rate: 96 }]);
    const layer = await one(`SELECT qty_received::float AS q, unit_cost::float AS c FROM inventory_fifo_layers
                              WHERE source_type = 'sales_return' AND source_id = $1`, [r.id]);
    expect(layer).toEqual({ q: 3, c: 96 });                          // not the selling price of 150
    expect(Number((await one(`SELECT restocked_qty FROM sales_return_items WHERE id = $1`, [r.lineId])).restocked_qty)).toBe(3);

    const again = await receive(co.A, r.id, [{ id: r.lineId, disposition: 'restock' }]);
    expect([again.status, again.body.code]).toEqual([409, 'ALREADY_RECEIVED']);
    expect((await returnLedger(r.id)).length).toBe(1);

    // 7 remain returnable: raising 8 is refused (Phase 3F). A return raised
    // before that check could still ask for 8 — the receipt refuses it too.
    const tooMany = await raise(co.A, so, [{ item_id: item, quantity: 8 }]);
    expect([tooMany.status, tooMany.body.code, tooMany.body.requestable_qty]).toEqual([409, 'RETURN_EXCEEDS_SHIPPED', 7]);
    const r2 = await rma(co.A, so, item, 7);
    await pool.query(`UPDATE sales_return_items SET quantity = 8 WHERE id = $1`, [r2.lineId]);   // the older, unchecked shape
    const over = await receive(co.A, r2.id, [{ id: r2.lineId, disposition: 'restock' }]);
    expect([over.status, over.body.code, over.body.returnable]).toEqual([409, 'RETURN_EXCEEDS_SHIPPED', 7]);
    expect(await returnLedger(r2.id)).toEqual([]);
    expect((await one(`SELECT status, received_at FROM sales_returns WHERE id = $1`, [r2.id])))
      .toEqual({ status: 'requested', received_at: null });
    await receive(co.A, r2.id, [{ id: r2.lineId, received_qty: 7, disposition: 'restock' }]).expect(200);
  });

  it('two simultaneous receipts against one order cannot both restock the same units', async () => {
    const { item, so } = await shipped(co.A, 10);
    const r1 = await rma(co.A, so, item, 6);
    const r2 = await rma(co.A, so, item, 4);                          // all that is left to request
    await pool.query(`UPDATE sales_return_items SET quantity = 6 WHERE id = $1`, [r2.lineId]);   // an older, unchecked RMA
    const results = await Promise.all([receive(co.A, r1.id, [{ id: r1.lineId, disposition: 'restock' }]), receive(co.A, r2.id, [{ id: r2.lineId, disposition: 'restock' }])]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const total = await num(`SELECT COALESCE(SUM(quantity_in), 0)::float FROM stock_ledger
                              WHERE reference_type = 'sales_return' AND reference_id = ANY($1)`, [[r1.id, r2.id]]);
    expect(total).toBe(6);
  });

  it('a malformed receipt is refused before anything is written', async () => {
    const { item, so } = await shipped(co.A, 5);
    const r = await rma(co.A, so, item, 2);
    const cases = [
      [[], 400, 'RECEIPT_LINES_REQUIRED'],
      [[{ id: r.lineId, disposition: 'restock' }, { id: r.lineId, disposition: 'restock' }], 400, 'RECEIPT_LINE_DUPLICATED'],
      [[{ id: 'x' }], 400, 'RECEIPT_LINE_INVALID'],
      [[{ id: 999999999 }], 404, 'RETURN_LINE_NOT_FOUND'],
      [[{ id: r.lineId, received_qty: 3, disposition: 'restock' }], 422, 'RECEIVED_QTY_INVALID'],
      [[{ id: r.lineId, received_qty: -1, disposition: 'restock' }], 422, 'RECEIVED_QTY_INVALID'],
      [[{ id: r.lineId, warehouse_id: co.B.wh, disposition: 'restock' }], 404, 'WAREHOUSE_NOT_FOUND'],
    ];
    for (const [lines, status, code] of cases) {
      const res = await receive(co.A, r.id, lines);
      expect([code, res.status, res.body.code]).toEqual([code, status, code]);
    }
    expect(await returnLedger(r.id)).toEqual([]);
    expect((await one(`SELECT status FROM sales_returns WHERE id = $1`, [r.id])).status).toBe('requested');
  });

  it('goods dispatched without a pick (no stock left) cannot come back into stock', async () => {
    const item = await makeItem(co.A, [[20, 100]]);
    const so = await makeSalesOrder(co.A);
    await request(appAs(co.A.id)).put(`/sales/orders/${so}/dispatch`).send({ carrier: 'ZZ' }).expect(200);
    // Refused when raised (Phase 3F) …
    const raised = await raise(co.A, so, [{ item_id: item, quantity: 1 }]);
    expect([raised.status, raised.body.code]).toEqual([409, 'RETURN_NOT_FROM_STOCK']);
    // … and at receipt, for a return raised before that check.
    const ret = (await pool.query(
      `INSERT INTO sales_returns (company_id, rma_number, sales_order_id, status) VALUES ($1, $2, $3, 'requested') RETURNING id`,
      [co.A.id, `${TAG}-OLD-${++seq}`, so])).rows[0].id;
    const line = (await pool.query(
      `INSERT INTO sales_return_items (return_id, company_id, item_id, quantity) VALUES ($1, $2, $3, 1) RETURNING id`,
      [ret, co.A.id, item])).rows[0].id;
    const res = await receive(co.A, ret, [{ id: line, disposition: 'restock' }]);
    expect([res.status, res.body.code]).toEqual([409, 'RETURN_NOT_FROM_STOCK']);
    expect(await returnLedger(ret)).toEqual([]);
  });

  it('a serialised unit is not restocked; scrap and failed QC move no stock and record nothing restocked', async () => {
    const { item, so } = await shipped(co.A, 10);
    const serial = (await pool.query(
      `INSERT INTO serial_numbers (serial_number, item_id, status, company_id) VALUES ($1, $2, 'sold', $3) RETURNING id`,
      [`${TAG}-SN-${++seq}`, item, co.A.id])).rows[0].id;
    const rs = await rma(co.A, so, item, 1, { serial_id: serial });
    const refused = await receive(co.A, rs.id, [{ id: rs.lineId, disposition: 'restock' }]);
    expect([refused.status, refused.body.code]).toEqual([409, 'SERIAL_RESTOCK_UNSUPPORTED']);
    await receive(co.A, rs.id, [{ id: rs.lineId, disposition: 'scrap' }]).expect(200);
    expect(await returnLedger(rs.id)).toEqual([]);

    const rq = await rma(co.A, so, item, 2);
    await receive(co.A, rq.id, [{ id: rq.lineId, disposition: 'restock', qc_result: 'fail' }]).expect(200);
    expect(await returnLedger(rq.id)).toEqual([]);
    const stored = await one(`SELECT disposition, qc_result, restocked_qty FROM sales_return_items WHERE id = $1`, [rq.lineId]);
    expect({ ...stored, restocked_qty: Number(stored.restocked_qty) }).toEqual({ disposition: 'restock', qc_result: 'fail', restocked_qty: 0 });
  });

  it('tenancy: create, receive and close are scoped; a shipment must be the order’s own', async () => {
    const a = await shipped(co.A, 5);
    const r = await rma(co.A, a.so, a.item, 1);
    await receive(co.B, r.id, [{ id: r.lineId, disposition: 'restock' }]).expect(404);
    expect(await returnLedger(r.id)).toEqual([]);
    expect((await raise(co.B, a.so, [{ item_id: a.item, quantity: 1 }])).status).toBe(404);

    const shipA = (await one(`SELECT id FROM shipments WHERE pick_list_id = $1`, [a.pl.id])).id;
    const otherSo = await makeSalesOrder(co.A);
    const mismatch = await raise(co.A, otherSo, [{ item_id: a.item, quantity: 1 }], { shipment_id: shipA });
    expect([mismatch.status, mismatch.body.code]).toEqual([422, 'SHIPMENT_ORDER_MISMATCH']);
    const badQty = await raise(co.A, a.so, [{ item_id: a.item, quantity: 0 }]);
    expect([badQty.status, badQty.body.code]).toEqual([422, 'RETURN_QTY_INVALID']);

    // Phase 3G: a return closes after it is received, with an ISSUED credit note.
    await receive(co.A, r.id, [{ id: r.lineId, disposition: 'scrap' }]).expect(200);
    const cnB = (await pool.query(
      `INSERT INTO credit_notes (credit_note_number, reason, company_id, status) VALUES ($1, 'sales_return', $2, 'issued') RETURNING id`,
      [`${TAG}-CN-${++seq}`, co.B.id])).rows[0].id;
    const cross = await request(appAs(co.A.id)).post(`/scm/returns/${r.id}/close`).send({ credit_note_id: cnB });
    expect([cross.status, cross.body.code]).toEqual([404, 'CREDIT_NOTE_NOT_FOUND']);
    expect((await one(`SELECT status, credit_note_id FROM sales_returns WHERE id = $1`, [r.id])))
      .toEqual({ status: 'received', credit_note_id: null });
    const cnDraft = (await pool.query(
      `INSERT INTO credit_notes (credit_note_number, reason, company_id) VALUES ($1, 'sales_return', $2) RETURNING id`,
      [`${TAG}-CN-${++seq}`, co.A.id])).rows[0].id;
    const notIssued = await request(appAs(co.A.id)).post(`/scm/returns/${r.id}/close`).send({ credit_note_id: cnDraft });
    expect([notIssued.status, notIssued.body.code]).toEqual([409, 'CREDIT_NOTE_NOT_ISSUED']);
    const cnA = (await pool.query(
      `INSERT INTO credit_notes (credit_note_number, reason, company_id, status) VALUES ($1, 'sales_return', $2, 'issued') RETURNING id`,
      [`${TAG}-CN-${++seq}`, co.A.id])).rows[0].id;
    const ok = await request(appAs(co.A.id)).post(`/scm/returns/${r.id}/close`).send({ credit_note_id: cnA });
    expect([ok.status, ok.body.credit_note_id]).toEqual([200, cnA]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Phase 3F: the returns contract the RMA screen relies on', () => {
  const raise = (c, so, lines, extra = {}) =>
    request(appAs(c.id)).post('/scm/returns').send({ sales_order_id: so, reason: 'ZZ', lines, ...extra });
  const receive = (c, ret, lines) => request(appAs(c.id)).post(`/scm/returns/${ret}/receive`).send({ lines });
  const close = (c, ret, body = {}) => request(appAs(c.id)).post(`/scm/returns/${ret}/close`).send(body);

  it('eligibility lists what the order shipped from stock, less returned and open requests, and the company warehouses', async () => {
    const { item, so } = await shipped(co.A, 10);
    await pool.query(`UPDATE sales_order_items SET item_id = $2 WHERE order_id = $1`, [so, item]);
    const r = await raise(co.A, so, [{ item_id: item, quantity: 3 }]);
    expect(r.status).toBe(201);
    expect(Number(r.body.items[0].unit_price)).toBe(100);             // the order's price when none is given
    const res = await request(appAs(co.A.id)).get('/scm/returns/eligible').query({ sales_order_id: so });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([expect.objectContaining({
      item_id: item, shipped_qty: 10, restocked_qty: 0, open_requested_qty: 3, requestable_qty: 7, warehouse_ids: [co.A.wh] })]);
    expect(res.body.warehouses.map(w => w.id)).toEqual([co.A.wh]);
    expect(res.body.dispositions).toEqual(['restock', 'repair', 'scrap', 'replace']);
    await request(appAs(co.B.id)).get('/scm/returns/eligible').query({ sales_order_id: so }).expect(404);
  });

  it('raising refuses, writing nothing: no lines, no item, a duplicated line, a serial of another item', async () => {
    const { item, so } = await shipped(co.A, 10);
    const other = await makeItem(co.A, [[5, 10]]);
    const foreignSerial = (await pool.query(
      `INSERT INTO serial_numbers (serial_number, item_id, status, company_id) VALUES ($1, $2, 'sold', $3) RETURNING id`,
      [`${TAG}-SN-${++seq}`, other, co.A.id])).rows[0].id;
    const before = await num(`SELECT COUNT(*)::int FROM sales_returns WHERE company_id = $1`, [co.A.id]);
    const cases = [
      [[], 400, 'RETURN_LINES_REQUIRED'],
      [[{ quantity: 1 }], 422, 'RETURN_ITEM_REQUIRED'],
      [[{ item_id: item, quantity: 1 }, { item_id: item, quantity: 2 }], 422, 'RETURN_LINE_DUPLICATED'],
      [[{ item_id: item, quantity: 1, serial_id: foreignSerial }], 422, 'SERIAL_ITEM_MISMATCH'],
      [[{ item_id: other, quantity: 1 }], 409, 'RETURN_NOT_FROM_STOCK'],
    ];
    for (const [lines, status, code] of cases) {
      const res = await raise(co.A, so, lines);
      expect([code, res.status, res.body.code]).toEqual([code, status, code]);
    }
    expect(await num(`SELECT COUNT(*)::int FROM sales_returns WHERE company_id = $1`, [co.A.id])).toBe(before);
  });

  it('a receipt line states its disposition and a valid QC result', async () => {
    const { item, so } = await shipped(co.A, 5);
    const r = await raise(co.A, so, [{ item_id: item, quantity: 2 }]);
    const line = r.body.items[0].id;
    for (const [l, code] of [
      [{ id: line }, 'DISPOSITION_REQUIRED'],
      [{ id: line, disposition: 'donate' }, 'DISPOSITION_INVALID'],
      [{ id: line, disposition: 'restock', qc_result: 'maybe' }, 'QC_RESULT_INVALID'],
    ]) {
      const res = await receive(co.A, r.body.id, [l]);
      expect([code, res.status, res.body.code]).toEqual([code, 422, code]);
    }
    expect((await one(`SELECT status, received_at FROM sales_returns WHERE id = $1`, [r.body.id])))
      .toEqual({ status: 'requested', received_at: null });
  });

  it('closing takes only a credit note of the company and of this order, and only once', async () => {
    const { item, so } = await shipped(co.A, 5);
    const r = await raise(co.A, so, [{ item_id: item, quantity: 1 }]);
    const dropped = await close(co.A, r.body.id, { disposition: 'scrap' });
    expect([dropped.status, dropped.body.code, dropped.body.fields]).toEqual([422, 'CLOSE_FIELD_UNKNOWN', ['disposition']]);
    const early = await close(co.A, r.body.id);
    expect([early.status, early.body.code]).toEqual([409, 'RECEIPT_OUTSTANDING']);
    await receive(co.A, r.body.id, [{ id: r.body.items[0].id, disposition: 'restock' }]).expect(200);

    const otherSo = await makeSalesOrder(co.A);
    const inv = (await pool.query(
      `INSERT INTO invoices (invoice_number, invoice_date, due_date, subtotal, tax_amount, total_amount, status, sales_order_id, company_id)
       VALUES ($1, '2026-10-01', '2026-10-31', 1, 0, 1, 'Sent', $2, $3) RETURNING id`, [`${TAG}-INV-${++seq}`, otherSo, co.A.id])).rows[0].id;
    const cnOther = (await pool.query(
      `INSERT INTO credit_notes (credit_note_number, reason, company_id, original_invoice_id, status) VALUES ($1, 'sales_return', $2, $3, 'issued') RETURNING id`,
      [`${TAG}-CN-${++seq}`, co.A.id, inv])).rows[0].id;
    const mismatch = await close(co.A, r.body.id, { credit_note_id: cnOther });
    expect([mismatch.status, mismatch.body.code]).toEqual([422, 'CREDIT_NOTE_ORDER_MISMATCH']);
    expect((await one(`SELECT status FROM sales_returns WHERE id = $1`, [r.body.id])).status).toBe('received');

    await close(co.A, r.body.id).expect(200);
    const twice = await close(co.A, r.body.id);
    expect([twice.status, twice.body.code]).toEqual([409, 'ALREADY_CLOSED']);
  });

  it('the list carries each return\'s lines, quantity and value', async () => {
    const { item, so } = await shipped(co.A, 5);
    const r = await raise(co.A, so, [{ item_id: item, quantity: 2, unit_price: 150 }]);
    const res = await request(appAs(co.A.id)).get('/scm/returns');
    const row = res.body.find(x => x.id === r.body.id);
    expect(row).toMatchObject({ line_count: 1, quantity: 2, total_value: 300 });
    expect(row.items).toEqual([expect.objectContaining({ id: r.body.items[0].id, item_id: item })]);
    expect((await request(appAs(co.B.id)).get('/scm/returns')).body.some(x => x.id === r.body.id)).toBe(false);
  });
});
