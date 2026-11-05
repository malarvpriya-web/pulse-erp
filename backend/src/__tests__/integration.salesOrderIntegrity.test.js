/**
 * integration.salesOrderIntegrity.test.js — Phase 3D: sales-order cancellation,
 * scoping, workflow-owned statuses, sales-order-level dispatch and shipment
 * numbering. Against the REAL database, through the REAL routers.
 *
 *   - An order cannot be cancelled while it has a pick list that is not
 *     cancelled; a pick list cannot be raised against a cancelled order; and a
 *     cancellation racing a pick-list creation never lets both win.
 *   - PUT /orders/:id, DELETE /orders/:id and the order-line routes act only on
 *     the caller's company; 'dispatched' / 'delivered' / 'invoiced' /
 *     'cancelled' cannot be written by editing.
 *   - Sales-order dispatch creates its shipment behind the same final-inspection
 *     gate as the warehouse, and refuses an order the warehouse is fulfilling.
 *   - Shipment references are per company: two companies can both dispatch,
 *     and two simultaneous dispatches in one company get different numbers.
 *
 * Every refusal is checked against the database. Cleanup is scoped to this
 * suite's two companies (table by table; the generic FK sweep only as a
 * fallback if the company row is still pinned).
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

const { default: pool }            = await import('../config/db.js');
const { default: warehouseRouter } = await import('../modules/warehouse/warehouse.routes.js');
const { default: salesRouter }     = await import('../modules/sales/routes/sales.routes.js');

const TAG = 'ZZSOINT';

function appAs(companyId, perms = '*') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId: 1, id: 1, roles: ['admin'], company_id: companyId, perms };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/warehouse', warehouseRouter);
  app.use('/sales', salesRouter);
  return app;
}

const co = {};

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  const items = `(SELECT id FROM inventory_items WHERE company_id = ANY($1))`;
  const steps = [
    `DELETE FROM inventory_fifo_consumption WHERE item_id IN ${items}`,
    `DELETE FROM inventory_fifo_layers WHERE item_id IN ${items}`,
    `DELETE FROM stock_ledger WHERE item_id IN ${items}`,
    `DELETE FROM shipments WHERE company_id = ANY($1)`,
    `DELETE FROM package_lines WHERE company_id = ANY($1)`,
    `DELETE FROM packages WHERE company_id = ANY($1)`,
    `DELETE FROM pick_list_lines WHERE pick_list_id IN (SELECT id FROM pick_lists WHERE company_id = ANY($1))`,
    `DELETE FROM pick_lists WHERE company_id = ANY($1)`,
    `DELETE FROM quality_tests WHERE production_order_id IN (SELECT id FROM production_orders WHERE company_id = ANY($1))`,
    `DELETE FROM production_orders WHERE company_id = ANY($1)`,
    `DELETE FROM sales_order_items WHERE order_id IN (SELECT id FROM sales_orders WHERE company_id = ANY($1))`,
    `DELETE FROM sales_orders WHERE company_id = ANY($1)`,
    `DELETE FROM audit_logs WHERE company_id = ANY($1)`,
    `DELETE FROM inventory_items WHERE company_id = ANY($1)`,
    `DELETE FROM warehouse_bins WHERE company_id = ANY($1)`,
    `DELETE FROM warehouse_zones WHERE warehouse_id IN (SELECT id FROM warehouses WHERE company_id = ANY($1))`,
    `DELETE FROM warehouses WHERE company_id = ANY($1)`,
    `DELETE FROM interview_questions WHERE company_id = ANY($1)`,
  ];
  for (const sql of steps) { try { await pool.query(sql, [ids]); } catch { /* fallback below */ } }
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
async function makeOrder(c, status = 'confirmed') {
  seq++;
  const so = (await pool.query(
    `INSERT INTO sales_orders (order_number, company_id, customer_name, order_status, subtotal, tax_amount, total_amount)
     VALUES ($1, $2, 'ZZ Customer', $3, 500, 0, 500) RETURNING id`, [`${TAG}-SO-${c.id}-${seq}`, c.id, status])).rows[0].id;
  await pool.query(
    `INSERT INTO sales_order_items (order_id, item_code, description, quantity, unit_price, tax_rate, total_amount)
     VALUES ($1, 'ZZ', 'ZZ goods', 5, 100, 0, 500)`, [so]);
  return so;
}
const pickListFor = (c, so, perms = '*') => request(appAs(c.id, perms)).post('/warehouse/pick-lists').send({
  sales_order_id: so,
  lines: [{ item_id: c.item, item_name: `${TAG} Item`, bin_location_id: c.bin, bin_code: 'B', required_qty: 2 }],
});
const orderRow = async (id) => (await pool.query(`SELECT * FROM sales_orders WHERE id = $1`, [id])).rows[0];
const stockOf = async (itemId) => Number((await pool.query(
  `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS q FROM stock_ledger WHERE item_id = $1`, [itemId])).rows[0].q);
const count = async (sql, params) => Number((await pool.query(sql, params)).rows[0].n);

beforeAll(async () => {
  await sweep();
  await makeCompany('A');
  await makeCompany('B');
}, 60_000);
afterAll(async () => { await sweep(); }, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
describe('sales-order cancellation with pick lists', () => {
  it('cancels an order with no pick lists', async () => {
    const so = await makeOrder(co.A);
    await request(appAs(co.A.id)).patch(`/sales/orders/${so}/cancel`).send({ reason: 'customer withdrew' }).expect(200);
    expect((await orderRow(so)).order_status).toBe('cancelled');
  });

  it('refuses while a pick list is open, then allows once it is cancelled', async () => {
    const so = await makeOrder(co.A);
    const pl = (await pickListFor(co.A, so).expect(201)).body;
    const r = await request(appAs(co.A.id)).patch(`/sales/orders/${so}/cancel`).send({ reason: 'x' });
    expect([r.status, r.body.code]).toEqual([409, 'OPEN_PICK_LISTS']);
    expect(r.body.pick_lists.map(p => p.id)).toEqual([pl.id]);
    expect((await orderRow(so)).order_status).toBe('confirmed');

    await request(appAs(co.A.id)).patch(`/warehouse/pick-lists/${pl.id}/status`).send({ status: 'cancelled' }).expect(200);
    await request(appAs(co.A.id)).patch(`/sales/orders/${so}/cancel`).send({ reason: 'x' }).expect(200);
    expect((await orderRow(so)).order_status).toBe('cancelled');
  });

  it('refuses while a picked list holds stock, and moves no stock', async () => {
    const so = await makeOrder(co.A);
    const pl = (await pickListFor(co.A, so).expect(201)).body;
    const { rows: [line] } = await pool.query(`SELECT id FROM pick_list_lines WHERE pick_list_id = $1`, [pl.id]);
    await request(appAs(co.A.id)).put(`/warehouse/pick-lists/${pl.id}/pick`)
      .send({ lines: [{ line_id: line.id, picked_qty: 2 }] }).expect(200);
    const before = await stockOf(co.A.item);
    await request(appAs(co.A.id)).patch(`/sales/orders/${so}/cancel`).send({ reason: 'x' }).expect(409);
    expect(await stockOf(co.A.item)).toBe(before);
    expect((await orderRow(so)).order_status).toBe('confirmed');
  });

  it('refuses a second cancellation', async () => {
    const so = await makeOrder(co.A, 'cancelled');
    const r = await request(appAs(co.A.id)).patch(`/sales/orders/${so}/cancel`).send({ reason: 'again' });
    expect([r.status, r.body.code]).toEqual([409, 'ALREADY_CANCELLED']);
  });

  it('a pick list cannot be raised against a cancelled order', async () => {
    const so = await makeOrder(co.A, 'cancelled');
    const r = await pickListFor(co.A, so);
    expect([r.status, r.body.code]).toEqual([409, 'ORDER_CANCELLED']);
    expect(await count(`SELECT COUNT(*)::int n FROM pick_lists WHERE sales_order_id = $1`, [so])).toBe(0);
  });

  it('a cancellation racing a pick-list creation never lets both succeed', async () => {
    for (let i = 0; i < 5; i++) {
      const so = await makeOrder(co.A);
      const [cancel, pick] = await Promise.all([
        request(appAs(co.A.id)).patch(`/sales/orders/${so}/cancel`).send({ reason: 'race' }),
        pickListFor(co.A, so),
      ]);
      const cancelled = (await orderRow(so)).order_status === 'cancelled';
      const lists = await count(`SELECT COUNT(*)::int n FROM pick_lists WHERE sales_order_id = $1`, [so]);
      expect([cancel.status === 200, pick.status === 201]).not.toEqual([true, true]);
      expect(cancelled && lists > 0).toBe(false);
    }
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════════
describe('order CRUD is scoped, and workflow statuses cannot be written by editing', () => {
  it('PUT /orders/:id: own order edits; another company\'s is 404 and unchanged', async () => {
    const soA = await makeOrder(co.A);
    await request(appAs(co.A.id)).put(`/sales/orders/${soA}`).send({ notes: 'edited' }).expect(200);
    expect((await orderRow(soA)).notes).toBe('edited');
    await request(appAs(co.B.id)).put(`/sales/orders/${soA}`).send({ notes: 'hijack' }).expect(404);
    expect((await orderRow(soA)).notes).toBe('edited');
  });

  it('refuses dispatched / delivered / invoiced / cancelled through PUT and PUT /status', async () => {
    const so = await makeOrder(co.A);
    for (const s of ['dispatched', 'delivered', 'invoiced', 'cancelled']) {
      const r1 = await request(appAs(co.A.id)).put(`/sales/orders/${so}`).send({ order_status: s });
      const r2 = await request(appAs(co.A.id)).put(`/sales/orders/${so}/status`).send({ status: s });
      expect([s, r1.status, r1.body.code, r2.status, r2.body.code]).toEqual([s, 409, 'WORKFLOW_STATUS', 409, 'WORKFLOW_STATUS']);
    }
    expect((await orderRow(so)).order_status).toBe('confirmed');
    expect(await count(`SELECT COUNT(*)::int n FROM shipments WHERE sales_order_id = $1`, [so])).toBe(0);
  });

  it('DELETE: another company\'s order is 404; an order with a pick list is refused; a plain one is deleted', async () => {
    const plain = await makeOrder(co.A);
    const withPick = await makeOrder(co.A);
    await pickListFor(co.A, withPick).expect(201);
    await request(appAs(co.B.id)).delete(`/sales/orders/${plain}`).expect(404);
    expect((await orderRow(plain)).deleted_at).toBeNull();
    const r = await request(appAs(co.A.id)).delete(`/sales/orders/${withPick}`);
    expect([r.status, r.body.code]).toEqual([409, 'ORDER_HAS_DEPENDENTS']);
    expect((await orderRow(withPick)).deleted_at).toBeNull();
    await request(appAs(co.A.id)).delete(`/sales/orders/${plain}`).expect(200);
    expect((await orderRow(plain)).deleted_at).not.toBeNull();
  });

  it('order lines: read and add only on the caller\'s own order', async () => {
    const soA = await makeOrder(co.A);
    expect((await request(appAs(co.A.id)).get(`/sales/orders/${soA}/items`)).body).toHaveLength(1);
    await request(appAs(co.B.id)).get(`/sales/orders/${soA}/items`).expect(404);
    await request(appAs(co.B.id)).post(`/sales/orders/${soA}/items`)
      .send({ item_description: 'hijack', quantity: 1, rate: 1 }).expect(404);
    expect(await count(`SELECT COUNT(*)::int n FROM sales_order_items WHERE order_id = $1`, [soA])).toBe(1);
    await request(appAs(co.A.id)).get('/sales/orders/abc/items').expect(404);
  });

  it('view-only callers cannot edit, delete or add lines', async () => {
    const so = await makeOrder(co.A);
    const view = ['sales:view'];
    await request(appAs(co.A.id, view)).put(`/sales/orders/${so}`).send({ notes: 'x' }).expect(403);
    await request(appAs(co.A.id, view)).delete(`/sales/orders/${so}`).expect(403);
    await request(appAs(co.A.id, view)).post(`/sales/orders/${so}/items`).send({ item_description: 'x' }).expect(403);
    await request(appAs(co.A.id, view)).put(`/sales/orders/${so}/dispatch`).send({}).expect(403);
    expect((await orderRow(so))).toMatchObject({ notes: null, deleted_at: null, order_status: 'confirmed' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('sales-order-level dispatch', () => {
  it('creates its shipment and moves the order; a repeat is refused', async () => {
    const so = await makeOrder(co.A);
    const r = await request(appAs(co.A.id)).put(`/sales/orders/${so}/dispatch`).send({ carrier: 'ZZ', tracking_number: 'T1' });
    expect(r.status).toBe(200);
    expect(r.body.dispatch_ref).toMatch(/^DSP-\d{6}$/);
    const { rows: [sh] } = await pool.query(`SELECT * FROM shipments WHERE sales_order_id = $1`, [so]);
    expect(sh).toMatchObject({ id: r.body.shipment_id, company_id: co.A.id, courier_partner: 'ZZ', tracking_number: 'T1', pick_list_id: null });
    expect((await orderRow(so)).order_status).toBe('dispatched');
    const again = await request(appAs(co.A.id)).put(`/sales/orders/${so}/dispatch`).send({});
    expect([again.status, again.body.code]).toEqual([409, 'ORDER_NOT_DISPATCHABLE']);
    expect(await count(`SELECT COUNT(*)::int n FROM shipments WHERE sales_order_id = $1`, [so])).toBe(1);
  });

  it('a failed final inspection blocks it — even with force — and writes nothing', async () => {
    const so = await makeOrder(co.A);
    const { rows: [po] } = await pool.query(
      `INSERT INTO production_orders (production_order_no, product_name, quantity_planned, sales_order_id, company_id, status)
       VALUES ($1, 'ZZ product', 1, $2, $3, 'completed') RETURNING id`, [`${TAG}-PO-${so}`, so, co.A.id]);
    await pool.query(
      `INSERT INTO quality_tests (source_type, test_name, production_order_id, result, status)
       VALUES ('production', 'ZZ FAT', $1, 'fail', 'completed')`, [po.id]);
    const r = await request(appAs(co.A.id)).put(`/sales/orders/${so}/dispatch`).send({ force: true });
    expect([r.status, r.body.code]).toEqual([409, 'FAT_GATE']);
    expect((await orderRow(so)).order_status).toBe('confirmed');
    expect(await count(`SELECT COUNT(*)::int n FROM shipments WHERE sales_order_id = $1`, [so])).toBe(0);
  });

  it('refuses an order the warehouse is fulfilling', async () => {
    const so = await makeOrder(co.A);
    await pickListFor(co.A, so).expect(201);
    const r = await request(appAs(co.A.id)).put(`/sales/orders/${so}/dispatch`).send({});
    expect([r.status, r.body.code]).toEqual([409, 'WAREHOUSE_FULFILMENT']);
    expect(await count(`SELECT COUNT(*)::int n FROM shipments WHERE sales_order_id = $1`, [so])).toBe(0);
  });

  it('another company\'s order is 404 and unchanged', async () => {
    const soB = await makeOrder(co.B);
    await request(appAs(co.A.id)).put(`/sales/orders/${soB}/dispatch`).send({ force: true }).expect(404);
    expect((await orderRow(soB)).order_status).toBe('confirmed');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('shipment references are per company', () => {
  it('two companies can each dispatch (the second used to collide on DSP-000001)', async () => {
    const soA = await makeOrder(co.A);
    const soB = await makeOrder(co.B);
    const rA = await request(appAs(co.A.id)).put(`/sales/orders/${soA}/dispatch`).send({});
    const rB = await request(appAs(co.B.id)).put(`/sales/orders/${soB}/dispatch`).send({});
    expect([rA.status, rB.status]).toEqual([200, 200]);
  });

  it('simultaneous dispatches in one company get different references', async () => {
    const orders = [await makeOrder(co.B), await makeOrder(co.B), await makeOrder(co.B)];
    const results = await Promise.all(orders.map(so => request(appAs(co.B.id)).put(`/sales/orders/${so}/dispatch`).send({})));
    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    expect(new Set(results.map(r => r.body.dispatch_ref)).size).toBe(3);
  }, 20_000);
});
