/**
 * integration.planToProduce.test.js — the Plan-to-Produce chain (Sales Order ->
 * Production -> Quality -> Engineering Change), against the REAL database.
 *
 * DELIBERATELY NOT MOCKED, same rationale as integration.salesPartners.test.js:
 * every other test in this repo stubs the pool, which proves control flow and
 * nothing about the SQL. These four flows were audited as broken or dead code
 * (2026-07-20/21 Enterprise Workflow Audit, "Plan to Produce" = 52/100) and then
 * fixed; writing this suite against the live schema is what caught a fifth,
 * unrelated bug the fixes depended on — sales_order_items' real columns are
 * description/unit_price/tax_rate/total_amount, not item_description/rate/
 * tax_percentage/total, so reading an order's items for BOM-matching or
 * production-order fallback fields threw and was silently swallowed.
 *
 * Self-cleaning: every row created is removed in afterAll, keyed off TAG.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';

// ── real DB credentials — see integration.salesPartners.test.js for why this
// has to happen before any import that reaches config/db.js ──────────────────
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

const { default: pool }       = await import('../config/db.js');
const { verifyToken }         = await import('../middlewares/auth.middleware.js');
const { buildApp }            = await import('./helpers/testApp.js');
const { makeToken }           = await import('./helpers/tokens.js');
const { default: salesRoutes }   = await import('../modules/sales/routes/sales.routes.js');
const { default: bomRoutes }     = await import('../modules/production/bom.routes.js');
const { default: mrpRoutes }     = await import('../modules/production/mrp.routes.js');
const { default: qualityRoutes } = await import('../modules/quality/quality.routes.js');
const { default: ecnRoutes }     = await import('../modules/engineering/ecn.routes.js');

const salesApp   = buildApp(['/api/sales', salesRoutes]);               // quality.routes.js/sales.routes.js call router.use(verifyToken) internally
const bomApp     = buildApp(['/api/production', verifyToken, bomRoutes]);
const mrpApp     = buildApp(['/api/mrp', verifyToken, mrpRoutes]);
const qualityApp = buildApp(['/api/quality', qualityRoutes]);
const ecnApp     = buildApp(['/api/engineering/ecn', verifyToken, ecnRoutes]);

// Admin is discovered, not hardcoded — see integration.salesPartners.test.js.
let ADMIN_ID;
const auth = () => `Bearer ${makeToken({ userId: ADMIN_ID, role: 'admin' })}`;

const TAG = `ZZTEST_${Date.now()}`;
const created = {
  sales_orders: [], projects: [], lifecycle_instances: [],
  production_orders: [], bom_headers: [], mrp_runs: [], mrp_planned_orders: [],
  inspection_checklists: [], inspection_reports: [], ncr_reports: [], quality_tests: [],
  engineering_changes: [],
};

beforeAll(async () => {
  const { rows } = await pool.query(
    `SELECT u.id FROM users u
       JOIN user_scope us ON us.user_id = u.id AND us.is_primary = true
      WHERE u.is_active = true AND u.logout_at IS NULL AND us.company_id = 1
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                     WHERE ur.user_id = u.id AND LOWER(r.code) IN ('admin','super_admin'))
      ORDER BY u.id LIMIT 1`
  );
  if (!rows[0]) throw new Error('No active company-scoped admin found — these tests need a seeded DB.');
  ADMIN_ID = rows[0].id;
});

afterAll(async () => {
  const del = async (label, sql, params) => {
    try { await pool.query(sql, params); } catch (e) { console.warn(`[cleanup] ${label} failed:`, e.message); }
  };
  if (created.quality_tests.length)         await del('quality_tests',         `DELETE FROM quality_tests WHERE id = ANY($1::int[])`, [created.quality_tests]);
  if (created.ncr_reports.length)           await del('ncr_reports',           `DELETE FROM ncr_reports WHERE id = ANY($1::int[])`, [created.ncr_reports]);
  if (created.inspection_reports.length)    await del('inspection_reports',    `DELETE FROM inspection_reports WHERE id = ANY($1::int[])`, [created.inspection_reports]);
  if (created.inspection_checklists.length) await del('inspection_checklists', `DELETE FROM inspection_checklists WHERE id = ANY($1::int[])`, [created.inspection_checklists]);
  if (created.production_orders.length)     await del('production_orders',     `DELETE FROM production_orders WHERE id = ANY($1::int[])`, [created.production_orders]); // cascades production_operations
  if (created.mrp_planned_orders.length)    await del('mrp_planned_orders',    `DELETE FROM mrp_planned_orders WHERE id = ANY($1::int[])`, [created.mrp_planned_orders]);
  if (created.mrp_runs.length)              await del('mrp_runs',              `DELETE FROM mrp_runs WHERE id = ANY($1::int[])`, [created.mrp_runs]);
  if (created.bom_headers.length)           await del('bom_headers',           `DELETE FROM bom_headers WHERE id = ANY($1::int[])`, [created.bom_headers]); // cascades routing_steps
  if (created.engineering_changes.length) {
    await del('ecn events',     `DELETE FROM engineering_change_events WHERE engineering_change_id = ANY($1::int[])`, [created.engineering_changes]);
    await del('ecn approvals',  `DELETE FROM engineering_change_approvals WHERE engineering_change_id = ANY($1::int[])`, [created.engineering_changes]);
    await del('ecn items',      `DELETE FROM engineering_change_items WHERE engineering_change_id = ANY($1::int[])`, [created.engineering_changes]);
    await del('engineering_changes', `DELETE FROM engineering_changes WHERE id = ANY($1::int[])`, [created.engineering_changes]);
  }
  if (created.lifecycle_instances.length) {
    await del('lifecycle_stage_history', `DELETE FROM lifecycle_stage_history WHERE lifecycle_instance_id = ANY($1::int[])`, [created.lifecycle_instances]);
    await del('lifecycle_instances', `DELETE FROM lifecycle_instances WHERE id = ANY($1::int[])`, [created.lifecycle_instances]);
  }
  if (created.projects.length)      await del('projects',      `DELETE FROM projects WHERE id = ANY($1::int[])`, [created.projects]);
  if (created.sales_orders.length)  await del('sales_orders',  `DELETE FROM sales_orders WHERE id = ANY($1::int[])`, [created.sales_orders]); // cascades sales_order_items
  await pool.end();
});

// ── Flow 1: Sales Order confirm -> production order, BOM-matched, routing copied ──
describe('SO confirm -> production order', () => {
  let bomId, soId;

  beforeAll(async () => {
    const bom = await pool.query(
      `INSERT INTO bom_headers (company_id, product_name, version, status) VALUES (1,$1,'1','active') RETURNING id`,
      [`${TAG} SO Product`]
    );
    bomId = bom.rows[0].id;
    created.bom_headers.push(bomId);
    await pool.query(`INSERT INTO routing_steps (bom_id, step_no, operation, std_time_hrs) VALUES ($1,1,'Fabricate',3)`, [bomId]);
    await pool.query(`INSERT INTO routing_steps (bom_id, step_no, operation, std_time_hrs) VALUES ($1,2,'Test',1)`, [bomId]);
  });

  it('creates the order and an item', async () => {
    const res = await request(salesApp).post('/api/sales/orders').set('Authorization', auth()).send({
      customer_name: `${TAG} Customer`, order_date: new Date().toISOString().slice(0, 10),
    });
    expect(res.status).toBe(201);
    soId = res.body.data.id;
    created.sales_orders.push(soId);

    const item = await request(salesApp).post(`/api/sales/orders/${soId}/items`).set('Authorization', auth()).send({
      item_description: `${TAG} SO Product`, quantity: 6, rate: 500, tax_percentage: 18,
    });
    // This 500s if the sales_order_items schema drift regresses (item_description/
    // rate/tax_percentage/total don't exist on the live table).
    expect(item.status).toBe(201);
    expect(item.body.item_description).toBe(`${TAG} SO Product`);
  });

  it('confirm creates a production order matched to the BOM, with no warning', async () => {
    const res = await request(salesApp).patch(`/api/sales/orders/${soId}/confirm`).set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.data.order_status).toBe('confirmed');
    // A warning means production-order auto-creation failed — see the dead-code /
    // schema-drift finding this test exists to guard against.
    expect(res.body.warning).toBeUndefined();

    const { rows: [lc] } = await pool.query(`SELECT * FROM lifecycle_instances WHERE sales_order_id=$1`, [soId]);
    expect(lc).toBeTruthy();
    expect(lc.production_order_id).not.toBeNull();
    created.lifecycle_instances.push(lc.id);
    if (lc.project_id) created.projects.push(lc.project_id);

    const { rows: [po] } = await pool.query(`SELECT * FROM production_orders WHERE id=$1`, [lc.production_order_id]);
    created.production_orders.push(po.id);
    expect(po).toMatchObject({ bom_id: bomId, product_name: `${TAG} SO Product`, sales_order_id: soId });
    expect(Number(po.quantity_planned)).toBe(6);

    const { rows: ops } = await pool.query(
      `SELECT step_no, operation FROM production_operations WHERE production_order_id=$1 ORDER BY step_no`, [po.id]
    );
    expect(ops.map(o => o.operation)).toEqual(['Fabricate', 'Test']);
  });
});

// ── Flow 2: Failed QC holds the parent production order ───────────────────────
describe('Failed QC holds the production order', () => {
  let checklistId, ncrAutoEnabled;

  beforeAll(async () => {
    const cl = await pool.query(
      `INSERT INTO inspection_checklists (name, type, items) VALUES ($1,'inward',$2) RETURNING id`,
      [`${TAG} Checklist`, JSON.stringify([{ step: 'Visual', measurement_type: 'pass_fail' }])]
    );
    checklistId = cl.rows[0].id;
    created.inspection_checklists.push(checklistId);

    const settings = await pool.query(`SELECT iqc_auto_ncr_on_fail FROM quality_settings WHERE company_id=1`);
    ncrAutoEnabled = settings.rows.length ? !!settings.rows[0].iqc_auto_ncr_on_fail : false;
  });

  const mkPO = async (suffix, status = 'released') => {
    const r = await pool.query(
      `INSERT INTO production_orders (production_order_no, product_name, quantity_planned, status, company_id)
       VALUES ($1,$2,1,$3,1) RETURNING id`,
      [`${TAG}-${suffix}`, `${TAG} PO ${suffix}`, status]
    );
    created.production_orders.push(r.rows[0].id);
    return r.rows[0].id;
  };

  it('POST /quality/inspect holds the order on a checklist fail', async () => {
    const poId = await mkPO('QCA');
    const res = await request(qualityApp).post('/api/quality/inspect').set('Authorization', auth()).send({
      checklist_id: checklistId, production_order_id: poId,
      inspector_name: `${TAG} Inspector`, results: { Visual: false },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('fail');
    created.inspection_reports.push(res.body.data.id);
    if (res.body.auto_ncr) created.ncr_reports.push(res.body.auto_ncr.id);
    if (ncrAutoEnabled) expect(res.body.auto_ncr).not.toBeNull();

    const { rows } = await pool.query('SELECT status FROM production_orders WHERE id=$1', [poId]);
    expect(rows[0].status).toBe('on_hold');
  });

  it('PUT /quality/tests/:id holds the order via a direct production_order_id', async () => {
    const poId = await mkPO('QCB');
    const t = await pool.query(
      `INSERT INTO quality_tests (company_id, source_type, source_id, production_order_id, test_name, expected_value)
       VALUES (1,'production_order',$1,$1,$2,'ok') RETURNING id`,
      [poId, `${TAG} test B`]
    );
    created.quality_tests.push(t.rows[0].id);

    const res = await request(qualityApp).put(`/api/quality/tests/${t.rows[0].id}`).set('Authorization', auth())
      .send({ actual_value: 'bad' });
    expect(res.status).toBe(200);
    expect(res.body.data.result).toBe('fail');
    if (res.body.auto_ncr) created.ncr_reports.push(res.body.auto_ncr.id);

    const { rows } = await pool.query('SELECT status FROM production_orders WHERE id=$1', [poId]);
    expect(rows[0].status).toBe('on_hold');
  });

  it('PUT /quality/tests/:id holds the order via the operation_id -> production_order chain', async () => {
    const poId = await mkPO('QCC');
    const op = await pool.query(
      `INSERT INTO production_operations (production_order_id, step_no, operation, status)
       VALUES ($1,1,'Assembly','pending') RETURNING id`, [poId]
    );
    const t = await pool.query(
      `INSERT INTO quality_tests (company_id, source_type, source_id, operation_id, test_name, expected_value)
       VALUES (1,'production_operation',$1,$1,$2,'ok') RETURNING id`,
      [op.rows[0].id, `${TAG} test C`]
    );
    created.quality_tests.push(t.rows[0].id);

    const res = await request(qualityApp).put(`/api/quality/tests/${t.rows[0].id}`).set('Authorization', auth())
      .send({ result: 'fail' });
    expect(res.status).toBe(200);
    if (res.body.auto_ncr) created.ncr_reports.push(res.body.auto_ncr.id);

    const { rows } = await pool.query('SELECT status FROM production_orders WHERE id=$1', [poId]);
    expect(rows[0].status).toBe('on_hold');
  });

  it('PUT /quality/inspect/:id (finalize) raises an NCR and holds the order — previously did neither', async () => {
    const poId = await mkPO('QCD');
    const insp = await request(qualityApp).post('/api/quality/inspect').set('Authorization', auth()).send({
      checklist_id: checklistId, reference_type: 'production_order', reference_id: poId,
      inspector_name: `${TAG} Inspector D`, results: {},
    });
    expect(insp.status).toBe(201);
    created.inspection_reports.push(insp.body.data.id);
    let chk = await pool.query('SELECT status FROM production_orders WHERE id=$1', [poId]);
    expect(chk.rows[0].status).not.toBe('on_hold'); // creation alone (no items yet) must not hold it

    const res = await request(qualityApp).put(`/api/quality/inspect/${insp.body.data.id}`).set('Authorization', auth())
      .send({ item_results: [{ item_id: 'Visual', result: false }], overall_result: 'fail', status: 'completed' });
    expect(res.status).toBe(200);
    if (ncrAutoEnabled) {
      expect(res.body.auto_ncr).not.toBeNull();
      created.ncr_reports.push(res.body.auto_ncr.id);
    }

    chk = await pool.query('SELECT status FROM production_orders WHERE id=$1', [poId]);
    expect(chk.rows[0].status).toBe('on_hold');
  });

  it('does not clobber a completed order back to on_hold', async () => {
    const poId = await mkPO('QCE', 'completed');
    const t = await pool.query(
      `INSERT INTO quality_tests (company_id, source_type, source_id, production_order_id, test_name, expected_value)
       VALUES (1,'production_order',$1,$1,$2,'ok') RETURNING id`,
      [poId, `${TAG} test E`]
    );
    created.quality_tests.push(t.rows[0].id);
    const res = await request(qualityApp).put(`/api/quality/tests/${t.rows[0].id}`).set('Authorization', auth()).send({ result: 'fail' });
    if (res.body.auto_ncr) created.ncr_reports.push(res.body.auto_ncr.id);
    const { rows } = await pool.query('SELECT status FROM production_orders WHERE id=$1', [poId]);
    expect(rows[0].status).toBe('completed');
  });
});

// ── Flow 3: MRP convert -> routing copied to production_operations ────────────
describe('MRP convert -> routing copied to production_operations', () => {
  let bomId, runId;

  beforeAll(async () => {
    const bom = await pool.query(
      `INSERT INTO bom_headers (company_id, product_name, version, status) VALUES (1,$1,'1','active') RETURNING id`,
      [`${TAG} MRP Product`]
    );
    bomId = bom.rows[0].id;
    created.bom_headers.push(bomId);
    await pool.query(`INSERT INTO routing_steps (bom_id, step_no, operation, std_time_hrs, is_inspection) VALUES ($1,1,'Cut',2,false)`, [bomId]);
    await pool.query(`INSERT INTO routing_steps (bom_id, step_no, operation, std_time_hrs, is_inspection) VALUES ($1,2,'Inspect',1,true)`, [bomId]);

    const run = await pool.query(`INSERT INTO mrp_runs (company_id) VALUES (1) RETURNING id`);
    runId = run.rows[0].id;
    created.mrp_runs.push(runId);
  });

  const mkPlannedOrder = async (suffix) => {
    const r = await pool.query(
      `INSERT INTO mrp_planned_orders (run_id, company_id, item_name, order_type, quantity, bom_id, status)
       VALUES ($1,1,$2,'make',4,$3,'planned') RETURNING id`,
      [runId, `${TAG} planned ${suffix}`, bomId]
    );
    created.mrp_planned_orders.push(r.rows[0].id);
    return r.rows[0].id;
  };

  it('POST /planned-orders/:id/convert copies routing_steps to production_operations', async () => {
    const plannedId = await mkPlannedOrder('A');
    const res = await request(mrpApp).post(`/api/mrp/planned-orders/${plannedId}/convert`).set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.created.type).toBe('production_order');
    created.production_orders.push(res.body.created.id);

    const { rows } = await pool.query(
      `SELECT step_no, operation, is_inspection FROM production_operations WHERE production_order_id=$1 ORDER BY step_no`,
      [res.body.created.id]
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ step_no: 1, operation: 'Cut', is_inspection: false });
    expect(rows[1]).toMatchObject({ step_no: 2, operation: 'Inspect', is_inspection: true });
  });

  it('POST /planned-orders/convert-all copies routing for every remaining planned order', async () => {
    await mkPlannedOrder('B'); // A is already converted, only B is still 'planned'
    const res = await request(mrpApp).post('/api/mrp/planned-orders/convert-all')
      .set('Authorization', auth()).send({ run_id: runId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ converted: 1, failed: 0, total: 1 });

    const { rows: [row] } = await pool.query(
      `SELECT converted_id FROM mrp_planned_orders WHERE run_id=$1 AND item_name=$2`,
      [runId, `${TAG} planned B`]
    );
    created.production_orders.push(row.converted_id);
    const { rows: ops } = await pool.query(
      `SELECT step_no, operation FROM production_operations WHERE production_order_id=$1 ORDER BY step_no`,
      [row.converted_id]
    );
    expect(ops).toHaveLength(2);
  });
});

// ── Flow 4: ECN implement -> BOM promoted from draft to active ────────────────
describe('ECN implement -> BOM promotion', () => {
  let origBomId, ecnId, newBomId;

  beforeAll(async () => {
    const r = await pool.query(
      `INSERT INTO bom_headers (company_id, product_name, version, status) VALUES (1,$1,'1','active') RETURNING id`,
      [`${TAG} ECN Product`]
    );
    origBomId = r.rows[0].id;
    created.bom_headers.push(origBomId);
  });

  it('POST /bom/:id/version creates a draft BOM linked to a draft ECN', async () => {
    const res = await request(bomApp).post(`/api/production/bom/${origBomId}/version`)
      .set('Authorization', auth()).send({ reason: `${TAG} change reason` });
    expect(res.status).toBe(201);
    ecnId = res.body.ecn_id;
    newBomId = res.body.id;
    created.engineering_changes.push(ecnId);
    created.bom_headers.push(newBomId);

    const { rows } = await pool.query(`SELECT status, ecn_id FROM bom_headers WHERE id=$1`, [newBomId]);
    expect(rows[0]).toMatchObject({ status: 'draft', ecn_id: ecnId });
  });

  it('submit + approve move the ECN to approved', async () => {
    let res = await request(ecnApp).post(`/api/engineering/ecn/changes/${ecnId}/submit`).set('Authorization', auth()).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('submitted');

    res = await request(ecnApp).post(`/api/engineering/ecn/changes/${ecnId}/approve`).set('Authorization', auth()).send({});
    expect(res.status).toBe(200);

    const { rows } = await pool.query(`SELECT status FROM engineering_changes WHERE id=$1`, [ecnId]);
    expect(rows[0].status).toBe('approved');
  });

  it('implement promotes the draft BOM to active and supersedes the old one — previously a status flag only', async () => {
    const res = await request(ecnApp).post(`/api/engineering/ecn/changes/${ecnId}/implement`).set('Authorization', auth()).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('implemented');
    expect(res.body.promoted_boms).toHaveLength(1);
    expect(res.body.promoted_boms[0].bom_id).toBe(newBomId);

    const { rows } = await pool.query(`SELECT id, status FROM bom_headers WHERE id = ANY($1::int[])`, [[origBomId, newBomId]]);
    const byId = Object.fromEntries(rows.map(r => [r.id, r.status]));
    expect(byId[newBomId]).toBe('active');
    expect(byId[origBomId]).toBe('superseded');
  });

  it('refuses to implement a change that is not approved (already implemented)', async () => {
    const res = await request(ecnApp).post(`/api/engineering/ecn/changes/${ecnId}/implement`).set('Authorization', auth()).send({});
    expect(res.status).toBe(400);
  });
});
