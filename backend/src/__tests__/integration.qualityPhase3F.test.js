/**
 * integration.qualityPhase3F.test.js — test-run updates and QC requirements.
 * Against the REAL database, through the REAL routers.
 *
 * WHAT IS PROVED (Phase 3F, priority 4)
 *   - PUT /quality/test-runs/:id saves what the FAT screen sends — result
 *     passed/failed/in-progress onto overall_result, measurements as new
 *     test_run_measurements rows — and refuses unknown fields and values
 *     outside the vocabularies, writing nothing. Scoped to the company; an NCR
 *     must be the company's. A FAT recorded as passed through it lets dispatch
 *     through; recorded as failed, it blocks.
 *   - Failed tests keep blocking dispatch, optional ones included.
 *   - QC requirements: none configured → the order is not blocked for missing
 *     inspections and readiness says qc_plan 'not_configured'. A configured
 *     requirement (order or product) with no passed record blocks dispatch on
 *     both paths as REQUIRED_MISSING — a pending, failed or other-product
 *     record never meets it; a passed one does. Retiring keeps the history.
 *     Creation is validated and company-scoped.
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

const { default: pool }            = await import('../config/db.js');
const { default: qualityRouter }   = await import('../modules/quality/quality.routes.js');
const { default: warehouseRouter } = await import('../modules/warehouse/warehouse.routes.js');
const { default: salesRouter }     = await import('../modules/sales/routes/sales.routes.js');
const { postStock }                = await import('../modules/production/subcontracting.routes.js');

const TAG = 'ZZQ3F';

function appAs(companyId, perms = '*') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId: 1, id: 1, roles: ['admin'], company_id: companyId, perms };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/quality', qualityRouter);
  app.use('/warehouse', warehouseRouter);
  app.use('/sales', salesRouter);
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
    `DELETE FROM test_run_measurements WHERE test_run_id IN (SELECT id FROM test_runs WHERE company_id = ANY($1))`,
    `DELETE FROM punch_points WHERE test_run_id IN (SELECT id FROM test_runs WHERE company_id = ANY($1))`,
    `DELETE FROM test_runs WHERE company_id = ANY($1)`,
    `DELETE FROM ncr_reports WHERE company_id = ANY($1)`,
    `DELETE FROM quality_tests WHERE production_order_id IN (SELECT id FROM production_orders WHERE company_id = ANY($1))`,
    `DELETE FROM production_orders WHERE company_id = ANY($1)`,
    `DELETE FROM inventory_fifo_consumption WHERE item_id IN ${items}`,
    `DELETE FROM inventory_fifo_layers WHERE item_id IN ${items}`,
    `DELETE FROM stock_ledger WHERE item_id IN ${items}`,
    `DELETE FROM shipments WHERE company_id = ANY($1)`,
    `DELETE FROM package_lines WHERE company_id = ANY($1)`,
    `DELETE FROM packages WHERE company_id = ANY($1)`,
    `DELETE FROM pick_list_lines WHERE pick_list_id IN (SELECT id FROM pick_lists WHERE company_id = ANY($1))`,
    `DELETE FROM pick_lists WHERE company_id = ANY($1)`,
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
async function makeItem(c) {
  seq++;
  const item = (await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, standard_cost)
     VALUES ($1, $2, $3, 'NOS', 100) RETURNING id`, [`${TAG}-${c.id}-I${seq}`, `${TAG} Item ${seq}`, c.id])).rows[0].id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await postStock(client, { itemId: item, warehouseId: c.wh, inQty: 50, rate: 100, txnType: 'opening',
      refType: 'opening', refId: null, remarks: `${TAG} opening`, companyId: c.id, transactionDate: '2026-09-01' });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return item;
}
/** An order for one item with one production order (product = the item), picked and ready to dispatch. */
async function readyOrder(c, { productId } = {}) {
  const item = await makeItem(c);
  seq++;
  const so = (await pool.query(
    `INSERT INTO sales_orders (order_number, company_id, customer_name, order_status, subtotal, tax_amount, total_amount)
     VALUES ($1, $2, 'ZZ Customer', 'confirmed', 100, 0, 100) RETURNING id`, [`${TAG}-SO-${seq}`, c.id])).rows[0].id;
  await pool.query(
    `INSERT INTO sales_order_items (order_id, item_id, item_code, description, quantity, unit_price, tax_rate, total_amount)
     VALUES ($1, $2, 'ZZ', 'ZZ goods', 2, 50, 0, 100)`, [so, item]);
  const po = (await pool.query(
    `INSERT INTO production_orders (production_order_no, product_name, product_id, quantity_planned, status, sales_order_id, company_id)
     VALUES ($1, 'ZZ product', $2, 1, 'released', $3, $4) RETURNING id`,
    [`${TAG}-PO-${seq}`, productId === undefined ? item : productId, so, c.id])).rows[0].id;
  const res = await request(appAs(c.id)).post('/warehouse/pick-lists').send({
    sales_order_id: so, lines: [{ item_id: item, item_name: 'ZZ', bin_location_id: c.bin, bin_code: 'B', required_qty: 2 }] });
  const { rows: [line] } = await pool.query(`SELECT id FROM pick_list_lines WHERE pick_list_id = $1`, [res.body.id]);
  await request(appAs(c.id)).put(`/warehouse/pick-lists/${res.body.id}/pick`)
    .send({ lines: [{ line_id: line.id, picked_qty: 2, bin_location_id: c.bin, item_id: item }] }).expect(200);
  return { item, so, po, pl: res.body.id };
}
const addRun = (c, po, result = 'in_progress') => pool.query(
  `INSERT INTO test_runs (production_order_id, test_stage, test_type, overall_result, status, company_id, title)
   VALUES ($1, 'FAT', 'functional', $2, 'pending', $3, 'ZZ FAT') RETURNING id`, [po, result, c.id]).then(r => r.rows[0].id);
const addTest = (c, po, { result = 'pass', mandatory = true, name = 'Hipot' } = {}) => pool.query(
  `INSERT INTO quality_tests (source_type, test_name, production_order_id, result, status, is_mandatory, company_id)
   VALUES ('production', $1, $2, $3, 'completed', $4, $5) RETURNING id`, [name, po, result, mandatory, c.id]).then(r => r.rows[0].id);
const dispatch = (c, f) => request(appAs(c.id)).post('/warehouse/dispatch').send({ pick_list_id: f.pl, courier: 'ZZ' });
const putRun = (c, id, body) => request(appAs(c.id)).put(`/quality/test-runs/${id}`).send(body);
const requirement = (c, body) => request(appAs(c.id)).post('/quality/qc-requirements').send(body);
const readiness = (c, so) => request(appAs(c.id)).get('/quality/dispatch-readiness').query({ sales_order_id: so });

beforeAll(async () => {
  await sweep();
  await makeCompany('A');
  await makeCompany('B');
}, 60_000);
afterAll(async () => {
  await sweep();
}, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
describe('PUT /quality/test-runs/:id', () => {
  it('saves what the FAT screen sends: the result, and the readings as measurement rows', async () => {
    const f = await readyOrder(co.A);
    const run = await addRun(co.A, f.po);
    const res = await putRun(co.A, run, {
      result: 'passed', status: 'passed',
      measurements: [
        { parameter: 'Insulation', specified: '500', actual: '612', unit: 'MΩ', result: 'pass' },
        { parameter: 'Leakage', specified: '< 5 mA', actual: 2.1, unit: 'mA', result: 'pass' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ overall_result: 'pass', status: 'passed', dispatch_blocked: false });
    expect(res.body.data.completed_at).not.toBeNull();
    const m = (await pool.query(
      `SELECT parameter_name, unit, measured_value::float v, target_value::float t, result, notes
         FROM test_run_measurements WHERE test_run_id = $1 ORDER BY id`, [run])).rows;
    expect(m).toEqual([
      { parameter_name: 'Insulation', unit: 'MΩ', v: 612, t: 500, result: 'pass', notes: null },
      { parameter_name: 'Leakage', unit: 'mA', v: 2.1, t: null, result: 'pass', notes: 'Specified: < 5 mA' },
    ]);
    const got = await request(appAs(co.A.id)).get(`/quality/test-runs/${run}`);
    expect(got.body.data.measurements).toHaveLength(2);

    // A FAT passed through the screen lets the order dispatch.
    expect((await dispatch(co.A, f)).status).toBe(200);
  });

  it('a FAT recorded as failed through it blocks dispatch', async () => {
    const f = await readyOrder(co.A);
    const run = await addRun(co.A, f.po);
    await putRun(co.A, run, { result: 'failed', status: 'failed' }).expect(200);
    const res = await dispatch(co.A, f);
    expect([res.status, res.body.code, res.body.blockers.map(b => b.kind)]).toEqual([409, 'FAT_GATE', ['FAILED']]);
  });

  it('refuses unknown fields and values outside the vocabularies, writing nothing', async () => {
    const f = await readyOrder(co.A);
    const run = await addRun(co.A, f.po);
    const before = await one(`SELECT overall_result, status, updated_at FROM test_runs WHERE id = $1`, [run]);
    const cases = [
      [{ result: 'passed', bogus: 1 }, 'UNKNOWN_FIELD'],
      [{ remarks: 'x' }, 'UNKNOWN_FIELD'],
      [{ result: 'great' }, 'RESULT_INVALID'],
      [{ status: 'done' }, 'STATUS_INVALID'],
      [{ customer_accepted: 'yes' }, 'CUSTOMER_ACCEPTED_INVALID'],
      [{ customer_accepted_at: 'someday' }, 'CUSTOMER_ACCEPTED_AT_INVALID'],
      [{ measurements: 'lots' }, 'MEASUREMENTS_INVALID'],
      [{ measurements: [{ parameter: 'V', actual: 'high', result: 'pass' }] }, 'MEASUREMENT_INVALID'],
      [{ measurements: [{ parameter: '', actual: 1, result: 'pass' }] }, 'MEASUREMENT_INVALID'],
      [{ measurements: [{ parameter: 'V', actual: 1, result: 'ok' }] }, 'MEASUREMENT_INVALID'],
      [{ result: 'passed', measurements: [{ parameter: 'V', actual: 1, result: 'pass' }, { parameter: 'W', actual: 'x', result: 'pass' }] }, 'MEASUREMENT_INVALID'],
      [{ ncr_id: 999999999 }, 'NCR_NOT_FOUND'],
    ];
    for (const [body, code] of cases) {
      const res = await putRun(co.A, run, body);
      expect([code, res.status, res.body.code]).toEqual([code, 422, code]);
    }
    expect(await one(`SELECT overall_result, status, updated_at FROM test_runs WHERE id = $1`, [run])).toEqual(before);
    expect(await num(`SELECT COUNT(*)::int FROM test_run_measurements WHERE test_run_id = $1`, [run])).toBe(0);
  });

  it("another company's run is not found, and is untouched", async () => {
    const f = await readyOrder(co.A);
    const run = await addRun(co.A, f.po);
    await putRun(co.B, run, { result: 'passed' }).expect(404);
    expect((await one(`SELECT overall_result FROM test_runs WHERE id = $1`, [run])).overall_result).toBe('in_progress');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('failed tests keep blocking', () => {
  it('a failed optional test still blocks dispatch', async () => {
    const f = await readyOrder(co.A);
    await addTest(co.A, f.po, { result: 'fail', mandatory: false });
    const res = await dispatch(co.A, f);
    expect([res.status, res.body.blockers.map(b => b.kind)]).toEqual([409, ['FAILED']]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('QC requirements', () => {
  it('none configured: not blocked for missing inspections, and readiness says the plan is not configured', async () => {
    const f = await readyOrder(co.A);
    const r = await readiness(co.A, f.so);
    expect(r.body.data).toMatchObject({ gate_on: true, qc_plan: 'not_configured', requirements: [], blockers: [], ready: true });
    const d = await dispatch(co.A, f);
    expect([d.status, d.body.qc_plan]).toEqual([200, 'not_configured']);
  });

  it('a required FAT with no passed run blocks — pending or failed never meets it; a passed one does', async () => {
    const f = await readyOrder(co.A);
    const req = await requirement(co.A, { sales_order_id: f.so, inspection: 'FAT' });
    expect(req.status).toBe(201);
    let res = await dispatch(co.A, f);
    expect([res.status, res.body.blockers.map(b => [b.source, b.kind])]).toEqual([409, [['qc_requirement', 'REQUIRED_MISSING']]]);

    const run = await addRun(co.A, f.po, 'in_progress');
    res = await dispatch(co.A, f);
    expect(res.body.blockers.map(b => b.kind).sort()).toEqual(['INCOMPLETE', 'REQUIRED_MISSING']);

    await putRun(co.A, run, { result: 'passed' }).expect(200);
    expect((await readiness(co.A, f.so)).body.data).toMatchObject({ qc_plan: 'configured', ready: true,
      requirements: [expect.objectContaining({ id: req.body.data.id, satisfied: true })] });
    res = await dispatch(co.A, f);
    expect([res.status, res.body.qc_plan]).toEqual([200, 'configured']);
  });

  it('a product requirement applies to every order carrying it, met only on a production order of that product', async () => {
    const f = await readyOrder(co.A, { productId: null });             // production order names no product
    await requirement(co.A, { item_id: f.item, inspection: 'quality_test', test_name: 'Hipot' }).expect(201);
    await addTest(co.A, f.po, { result: 'pass', name: 'Hipot' });
    let res = await dispatch(co.A, f);
    expect([res.status, res.body.blockers.map(b => b.kind)]).toEqual([409, ['REQUIRED_MISSING']]);

    await pool.query(`UPDATE production_orders SET product_id = $2 WHERE id = $1`, [f.po, f.item]);
    await addTest(co.A, f.po, { result: 'pass', name: 'Burn-in' });    // another test does not meet it either way
    res = await dispatch(co.A, f);
    expect(res.status).toBe(200);
  });

  it('sales-order dispatch is held to the same requirements, force or not', async () => {
    const f = await readyOrder(co.A);
    await request(appAs(co.A.id)).patch(`/warehouse/pick-lists/${f.pl}/status`).send({ status: 'cancelled' }).expect(200);
    // Sales-order dispatch ships only non-stock lines (Phase 3G); make the order a service order.
    await pool.query(`UPDATE sales_order_items SET item_id = NULL WHERE order_id = $1`, [f.so]);
    await requirement(co.A, { sales_order_id: f.so, inspection: 'quality_test' }).expect(201);
    await addTest(co.A, f.po, { result: 'pending', mandatory: false });
    const res = await request(appAs(co.A.id)).put(`/sales/orders/${f.so}/dispatch`).send({ carrier: 'ZZ', force: true });
    expect([res.status, res.body.code, res.body.blockers.map(b => b.kind)]).toEqual([409, 'FAT_GATE', ['REQUIRED_MISSING']]);
    expect(await num(`SELECT COUNT(*)::int FROM shipments WHERE sales_order_id = $1`, [f.so])).toBe(0);
  });

  it('retiring keeps the history and lifts the block; creation is validated and scoped', async () => {
    const f = await readyOrder(co.A);
    const r = await requirement(co.A, { sales_order_id: f.so, inspection: 'FAT' });
    expect((await requirement(co.A, { sales_order_id: f.so, inspection: 'FAT' })).body.code).toBe('REQUIREMENT_EXISTS');
    for (const [body, status, code] of [
      [{ sales_order_id: f.so, inspection: 'SAT' }, 422, 'INSPECTION_INVALID'],
      [{ inspection: 'FAT' }, 422, 'SCOPE_INVALID'],
      [{ sales_order_id: f.so, item_id: f.item, inspection: 'FAT' }, 422, 'SCOPE_INVALID'],
      [{ sales_order_id: f.so, inspection: 'FAT', test_name: 'x' }, 422, 'TEST_NAME_INVALID'],
      [{ sales_order_id: f.so, inspection: 'FAT', mandatory: false }, 422, 'UNKNOWN_FIELD'],
    ]) {
      const res = await requirement(co.A, body);
      expect([code, res.status, res.body.code]).toEqual([code, status, code]);
    }
    expect((await requirement(co.B, { sales_order_id: f.so, inspection: 'FAT' })).body.code).toBe('SALES_ORDER_NOT_FOUND');
    await request(appAs(co.B.id)).delete(`/quality/qc-requirements/${r.body.data.id}`).expect(404);
    await readiness(co.B, f.so).expect(404);

    await request(appAs(co.A.id)).delete(`/quality/qc-requirements/${r.body.data.id}`).expect(200);
    expect(await one(`SELECT active, retired_by FROM qc_requirements WHERE id = $1`, [r.body.data.id])).toEqual({ active: false, retired_by: 1 });
    expect((await dispatch(co.A, f)).status).toBe(200);
  });
});
