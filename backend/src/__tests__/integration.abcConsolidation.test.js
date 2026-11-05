/**
 * integration.abcConsolidation.test.js — ONE ABC engine, explicit ownership,
 * one threshold source. Against the REAL database, through the REAL routers.
 *
 * WHAT WAS WRONG (inventory classification, Phase 2)
 *
 *   1. Four ABC engines. Besides the planning service, three endpoints ran their
 *      own Pareto — /abc-analysis/run (cached as JSON, served however stale),
 *      /inventory-report?type=abc_analysis and /dept-cost-analysis (assignAbc,
 *      per store) — each hard-coding 70/90, banding on the cumulative AFTER the
 *      item, counting transfers as demand, ignoring manual overrides.
 *   2. Ownership of abc_class was inferred, so an override equal to the
 *      calculated class was invisible and got moved by the next recompute.
 *   3. Inventory Settings saved ABC cutoffs the engine never read.
 *   4. An item that fell below the history minimum kept its last EOQ, safety
 *      stock and reorder point calculations, presented as current.
 *
 * Only the permission gates are stubbed: tenant scope (companyOf) is the
 * route's own and stays real. Self-cleaning: two companies tagged ZZABCCON,
 * swept on the way in and out.
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

vi.mock('../middlewares/auth.middleware.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, requirePermission: () => (_req, _res, next) => next() };
});
vi.mock('../modules/procurement/procurement.authz.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, requireProcurement: () => (_req, _res, next) => next() };
});

const { default: pool }            = await import('../config/db.js');
const planning                     = await import('../modules/inventory/services/inventoryPlanning.service.js');
const { recalcCompany }            = await import('../jobs/planningRecalc.cron.js');
const { backfillAbcClassSource }   = await import('../database/migrations/20261021000009_abc_class_source.js');
const { default: inventoryRouter } = await import('../modules/inventory/routes/inventory.routes.js');
const { default: settingsRouter }  = await import('../modules/admin/settings-status.routes.js');
const { default: procurementRouter } = await import('../modules/procurement/routes/procurement.routes.js');

const TAG = 'ZZABCCON';

function appAs(companyId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId: 1, id: 1, roles: ['admin'], company_id: companyId };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/inventory', inventoryRouter);
  app.use('/settings', settingsRouter);
  app.use('/procurement', procurementRouter);
  return app;
}

let A, B, whProd, whSvc, whB;
const item = {};
const knexShim = { raw: (sql, b) => pool.query(sql, b || []) };

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const co = rows.map(r => r.id);
  if (!co.length) return;
  const ours = `(SELECT id FROM inventory_items WHERE company_id = ANY($1))`;
  await pool.query(`DELETE FROM inventory_planning_run_items WHERE item_id IN ${ours} OR company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM inventory_planning_runs     WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM inventory_planning_settings WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM abc_analysis_cache          WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM company_settings            WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM audit_logs                  WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM stock_ledger                WHERE item_id IN ${ours}`, [co]);
  await pool.query(`DELETE FROM inventory_items             WHERE company_id = ANY($1)`, [co]);
  await pool.query(`DELETE FROM warehouses                  WHERE company_id = ANY($1)`, [co]);
  const { rows: fks } = await pool.query(`
    SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu  ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'companies'`);
  for (let pass = 0; pass < 2; pass++) {
    for (const { table_name, column_name } of fks) {
      try {
        await pool.query(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1)`, [co]);
      } catch { /* FK ordering — the second pass picks it up */ }
    }
  }
  await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

async function makeCompany(suffix) {
  const { rows } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${suffix}`, `${TAG}${suffix}`]);
  return rows[0].id;
}
async function makeWarehouse(companyId, suffix, department) {
  const { rows } = await pool.query(
    `INSERT INTO warehouses (name, warehouse_name, company_id, department) VALUES ($1, $1, $2, $3) RETURNING id`,
    [`${TAG} WH ${suffix}`, companyId, department]);
  return rows[0].id;
}
/** Any inventory_items columns; an explicit null is inserted as NULL (it beats the column default). */
async function makeItem(companyId, suffix, cols = {}) {
  const all = { item_code: `${TAG}-${companyId}-${suffix}`, item_name: `${TAG} ${suffix}`,
                company_id: companyId, unit_of_measure: 'NOS', standard_cost: 100, ...cols };
  const keys = Object.keys(all);
  const { rows } = await pool.query(
    `INSERT INTO inventory_items (${keys.join(', ')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, keys.map(k => all[k]));
  item[suffix] = rows[0].id;
  return rows[0].id;
}
async function monthlyIssue(companyId, wh, itemId, qty, monthsAgo) {
  await pool.query(
    `INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, quantity_in, quantity_out,
                               rate, transaction_date, company_id, remarks)
     VALUES ($1, $2, 'consumption', 0, $3, 0,
             (date_trunc('month', CURRENT_DATE) - make_interval(months => $4::int))::date, $5, $6)`,
    [itemId, wh, qty, monthsAgo, companyId, `${TAG} fixture`]);
}
async function ledger(companyId, wh, itemId, type, qtyIn, qtyOut, daysAgo) {
  await pool.query(
    `INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, quantity_in, quantity_out,
                               rate, transaction_date, company_id, remarks)
     VALUES ($1, $2, $3, $4, $5, 0, CURRENT_DATE - $6::int, $7, $8)`,
    [itemId, wh, type, qtyIn, qtyOut, daysAgo, companyId, `${TAG} fixture`]);
}
const row = async (id) => (await pool.query(`SELECT * FROM inventory_items WHERE id = $1`, [id])).rows[0];
const cls = (v) => (v == null ? null : String(v).trim());
const settingsOf = async (cid) => (await pool.query(
  `SELECT abc_a_threshold_pct::float8 AS a, abc_b_threshold_pct::float8 AS b,
          fsn_slow_days, fsn_nonmoving_days FROM inventory_planning_settings WHERE company_id = $1`, [cid])).rows[0];
const blobOf = async (cid) => (await pool.query(
  `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'inventory'`, [cid])).rows[0]?.settings;
async function auditRows(type, recordId, cid, atLeast = 1) {
  // logAudit is fire-and-forget, so poll until the EXPECTED number of rows has
  // landed. Returning on the first row raced the second insert whenever an
  // earlier action had already logged one (the pin, before its release).
  for (let i = 0; i < 80; i++) {
    const { rows } = await pool.query(
      `SELECT * FROM audit_logs WHERE reference_type = $1 AND reference_id = $2 AND company_id = $3`,
      [type, String(recordId), cid]);
    if (rows.length >= atLeast) return rows;
    await new Promise(r => { setTimeout(r, 100); });
  }
  return [];
}

// Annual consumption = 120 units for every steady item; value = 120 x cost.
//   P1 800 -> 96 000   P2 150 -> 18 000   P3 40 -> 4 800
//   MEQ 5, MOV 4, CLR 3, LEG/LEGM/LEGN/LEG0 2 each         -> 2 400
// Total 121 200. Cumulative BEFORE each item: P1 0%, P2 79.21%, P3 94.06%.
// At 70/90: P1 A, P2 B, everything else C.
const STEADY = { P1: 800, P2: 150, P3: 40, MEQ: 5, MOV: 4, CLR: 3 };

beforeAll(async () => {
  await sweep();
  A = await makeCompany('A');
  B = await makeCompany('B');
  whProd = await makeWarehouse(A, 'PROD', 'production');
  whSvc  = await makeWarehouse(A, 'SVC', 'service');
  whB    = await makeWarehouse(B, 'B', 'production');
  for (const cid of [A, B]) {
    await pool.query(`
      INSERT INTO inventory_planning_settings
        (company_id, lookback_days, min_periods_for_stats, auto_apply,
         abc_a_threshold_pct, abc_b_threshold_pct, xyz_x_max_cv, xyz_y_max_cv,
         fsn_slow_days, fsn_nonmoving_days)
      VALUES ($1, 365, 3, true, 70, 90, 0.5, 1.0, 90, 180)`, [cid]);
  }
  // The unapplied legacy blob values Inventory Settings used to save.
  await pool.query(`INSERT INTO company_settings (company_id, module, settings)
                    VALUES ($1, 'inventory', $2::jsonb), ($3, 'inventory', $4::jsonb)`,
    [A, JSON.stringify({ abc_a_threshold: 20, abc_b_threshold: 30, slow_mover_days: 90 }),
     B, JSON.stringify({ abc_a_threshold: 50, abc_b_threshold: 60, slow_mover_days: 45 })]);

  for (const [k, cost] of Object.entries(STEADY)) await makeItem(A, k, { standard_cost: cost });
  // Legacy rows exactly as the migration found them: source NULL.
  await makeItem(A, 'LEG',  { standard_cost: 2, abc_class: 'C', abc_class_calculated: 'C', abc_class_source: null });
  await makeItem(A, 'LEGM', { standard_cost: 2, abc_class: 'A', abc_class_calculated: 'C', abc_class_source: null });
  await makeItem(A, 'LEGN', { standard_cost: 2, abc_class: 'B', abc_class_calculated: null, abc_class_source: null });
  await makeItem(A, 'LEG0', { standard_cost: 2, abc_class: null, abc_class_calculated: null, abc_class_source: null });
  for (const k of [...Object.keys(STEADY), 'LEG', 'LEGM', 'LEGN', 'LEG0']) {
    for (let m = 0; m < 12; m++) {
      if (k === 'P1') {        // carried by two stores, so it appears in both departments
        await monthlyIssue(A, whProd, item[k], 5, m);
        await monthlyIssue(A, whSvc, item[k], 5, m);
      } else {
        await monthlyIssue(A, whProd, item[k], 10, m);
      }
    }
  }
  // An item that once had full parameters and has since lost its history.
  await makeItem(A, 'STALEP', {
    standard_cost: 25, abc_class: 'B', abc_class_calculated: 'B', abc_class_source: 'calculated',
    eoq: 50, safety_stock_calculated: 5, reorder_point_calculated: 8,
    annual_demand: 100, avg_daily_demand: 0.274, demand_stddev: 3, annual_consumption_value: 2500,
    planning_params_computed_at: new Date(), safety_stock: 7, reorder_level: 9,
    safety_stock_source: 'calculated', reorder_point_source: 'calculated' });
  await ledger(A, whProd, item.STALEP, 'receipt', 40, 0, 300);
  await ledger(A, whProd, item.STALEP, 'consumption', 0, 2, 200);

  // A stale cached analysis that claims P3 is A. Nothing may serve it.
  await pool.query(
    `INSERT INTO abc_analysis_cache (stats, items, company_id, computed_at) VALUES ($1, $2, $3, NOW() + INTERVAL '1 day')`,
    [JSON.stringify({ A: { count: 1, value: 1 }, B: { count: 0, value: 0 }, C: { count: 0, value: 0 } }),
     JSON.stringify([{ item_id: 0, item_code: 'CACHED', category: 'A' }]), A]);

  // Company B: a manual class and its own steady demand.
  await makeItem(B, 'BMAN', { standard_cost: 100, abc_class: 'B', abc_class_calculated: 'C', abc_class_source: 'manual' });
  for (let m = 0; m < 12; m++) await monthlyIssue(B, whB, item.BMAN, 10, m);
}, 120_000);

afterAll(async () => { await sweep(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('legacy ownership (migration 20261021000009 backfill)', () => {
  beforeAll(async () => { await backfillAbcClassSource(knexShim, [A, B]); });

  // 7
  it('marks only what it can prove, and leaves the ambiguous case NULL', async () => {
    expect((await row(item.LEG)).abc_class_source).toBeNull();          // equal to calculated: unknown author
    expect((await row(item.LEGM)).abc_class_source).toBe('manual');     // differs from calculated
    expect((await row(item.LEGN)).abc_class_source).toBe('manual');     // engine never classified it
    expect((await row(item.LEG0)).abc_class_source).toBe('calculated'); // nothing to own
    expect((await row(item.BMAN)).abc_class_source).toBe('manual');     // already set: untouched
  });

  it('reports the ambiguous row as legacy_unverified until a run resolves it', async () => {
    const res = await request(appAs(A)).get('/inventory/planning/abc');
    const leg = res.body.items.find(i => i.id === item.LEG);
    expect(leg.classification_status).toBe('legacy_unverified');
  });

  it('refuses a manual source with no class, at the database', async () => {
    await expect(pool.query(
      `UPDATE inventory_items SET abc_class = NULL, abc_class_source = 'manual' WHERE id = $1`, [item.LEG0]))
      .rejects.toThrow(/inventory_items_abc_class_source_chk/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Pareto boundary (the one engine)', () => {
  // 2
  const three = () => [{ id: 1, acv: 80 }, { id: 2, acv: 15 }, { id: 3, acv: 5 }];
  const run = (aPct, bPct) => planning.classifyABCPareto(three(), { valueFn: r => r.acv, aPct, bPct })
    .map(r => r.abc_class);

  it('bands on the cumulative BEFORE the item; an item sitting exactly on a threshold takes the lower class', () => {
    expect(run(70, 90)).toEqual(['A', 'B', 'C']);   // the old "after" test made the 80% item B
    expect(run(80, 95)).toEqual(['A', 'B', 'C']);   // item 2 starts exactly at 80, item 3 exactly at 95
  });
  it('moves an item across as soon as the threshold passes its starting cumulative', () => {
    expect(run(80.01, 95)).toEqual(['A', 'A', 'C']);
    expect(run(80, 95.01)).toEqual(['A', 'B', 'B']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ownership through recompute', () => {
  let app;
  beforeAll(async () => {
    app = appAs(A);
    // Pins made before any run, through both APIs that can make them.
    await request(app).put(`/inventory/planning/parameters/${item.MEQ}`).send({ abc_class: 'C' }).expect(200);
    await request(app).put(`/inventory/planning/parameters/${item.CLR}`).send({ abc_class: 'A' }).expect(200);
    await request(app).put(`/inventory/items/${item.MOV}`)
      .send({ item_name: `${TAG} MOV`, unit_of_measure: 'NOS', standard_cost: 4, abc_class: 'A' }).expect(200);
    // 9 — the nightly job's own call.
    await recalcCompany(A);
  }, 60_000);

  it('classifies by the one engine', async () => {
    expect(cls((await row(item.P1)).abc_class)).toBe('A');
    expect(cls((await row(item.P2)).abc_class)).toBe('B');
    expect(cls((await row(item.P3)).abc_class)).toBe('C');
  });

  // 4
  it('keeps a manual override that differs from the calculation', async () => {
    const r = await row(item.MOV);
    expect([cls(r.abc_class), r.abc_class_calculated, r.abc_class_source]).toEqual(['A', 'C', 'manual']);
  });

  // 5 (first half — the second half moves the calculation, below)
  it('records an override EQUAL to the calculation as manual', async () => {
    const r = await row(item.MEQ);
    expect([cls(r.abc_class), r.abc_class_calculated, r.abc_class_source]).toEqual(['C', 'C', 'manual']);
  });

  it('resolves the legacy rows: ambiguous -> engine-owned, provable manual kept', async () => {
    const leg = await row(item.LEG), legm = await row(item.LEGM);
    expect([cls(leg.abc_class), leg.abc_class_source]).toEqual(['C', 'calculated']);
    expect([cls(legm.abc_class), legm.abc_class_source]).toEqual(['A', 'manual']);
  });

  // 6
  it('clearing an override returns the item to the calculated class (planning API)', async () => {
    const res = await request(app).put(`/inventory/planning/parameters/${item.CLR}`).send({ abc_class: null });
    expect(res.status).toBe(200);
    const r = await row(item.CLR);
    expect([cls(r.abc_class), r.abc_class_source]).toEqual(['C', 'calculated']);
    const audit = await auditRows('inventory_item_planning', item.CLR, A, 2);
    expect(audit.length).toBeGreaterThanOrEqual(2);              // the pin and the release
  }, 20_000);

  it('clearing an override returns the item to the calculated class (Item Master blank)', async () => {
    await request(app).put(`/inventory/items/${item.LEGN}`)
      .send({ item_name: `${TAG} LEGN`, unit_of_measure: 'NOS', standard_cost: 2, abc_class: '' }).expect(200);
    const r = await row(item.LEGN);
    expect([cls(r.abc_class), r.abc_class_source]).toEqual(['C', 'calculated']);
  });

  it('an Item Master save that does not mention abc_class leaves ownership alone', async () => {
    await request(app).put(`/inventory/items/${item.MOV}`)
      .send({ item_name: `${TAG} MOV`, unit_of_measure: 'NOS', standard_cost: 4 }).expect(200);
    const r = await row(item.MOV);
    expect([cls(r.abc_class), r.abc_class_source]).toEqual(['A', 'manual']);
  });

  it('rejects a class that is not A, B, C or blank, and changes nothing', async () => {
    await request(app).put(`/inventory/planning/parameters/${item.MOV}`).send({ abc_class: 'D' }).expect(400);
    await request(app).put(`/inventory/items/${item.MOV}`)
      .send({ item_name: `${TAG} MOV`, unit_of_measure: 'NOS', standard_cost: 4, abc_class: 'X' }).expect(422);
    expect(cls((await row(item.MOV)).abc_class)).toBe('A');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('every ABC consumer gives the same answer', () => {
  let app, truth;
  beforeAll(async () => {
    app = appAs(A);
    const { rows } = await pool.query(
      `SELECT id, item_code, abc_class FROM inventory_items WHERE company_id = $1 AND abc_class IS NOT NULL`, [A]);
    truth = new Map(rows.map(r => [r.item_code, cls(r.abc_class)]));
  });

  // 1 + 14
  it('/planning/abc, /abc-analysis, the inventory report and the store analysis agree item by item', async () => {
    const planningAbc = (await request(app).get('/inventory/planning/abc')).body.items;
    const analysis    = (await request(app).get('/inventory/abc-analysis')).body;
    const report      = (await request(app).get('/inventory/inventory-report').query({ type: 'abc_analysis' })).body;
    const dept        = (await request(app).get('/inventory/dept-cost-analysis')).body;

    const views = {
      planning:     new Map(planningAbc.filter(i => i.abc_class).map(i => [i.item_code, cls(i.abc_class)])),
      analysis:     new Map(analysis.items.map(i => [i.item_code, i.category])),
      report:       new Map(report.rows.map(r => [r.item_code, r.abc_class])),
      consolidated: new Map(dept.consolidated.items.filter(i => i.abc_category).map(i => [i.item_code, i.abc_category])),
    };
    for (const d of dept.departments) {
      views[`dept:${d.department}`] = new Map(d.items.filter(i => i.abc_category).map(i => [i.item_code, i.abc_category]));
    }
    for (const [name, view] of Object.entries(views)) {
      for (const [code, c] of view) expect([name, code, c]).toEqual([name, code, truth.get(code)]);
    }
    for (const name of ['planning', 'analysis', 'report', 'consolidated']) {
      expect([name, views[name].size]).toEqual([name, truth.size]);
    }
    // P1 is carried by two stores and is A in both — not A in one, C in the other.
    expect(views['dept:production'].get(`${TAG}-${A}-P1`)).toBe('A');
    expect(views['dept:service'].get(`${TAG}-${A}-P1`)).toBe('A');
    // A manual override shows on every screen, not just Item Master.
    expect(views.analysis.get(`${TAG}-${A}-MOV`)).toBe('A');
    expect(views.consolidated.get(`${TAG}-${A}-MOV`)).toBe('A');
  });

  // 14
  it('keeps each endpoint\'s response contract', async () => {
    const analysis = (await request(app).get('/inventory/abc-analysis')).body;
    expect(Object.keys(analysis.stats).sort()).toEqual(['A', 'B', 'C']);
    for (const k of ['A', 'B', 'C']) expect(analysis.stats[k]).toEqual({ count: expect.any(Number), value: expect.any(Number) });
    expect(analysis.last_computed).toBeTruthy();
    expect(Object.keys(analysis.items[0])).toEqual(expect.arrayContaining(
      ['item_id', 'item_code', 'item_name', 'annual_consumption_value', 'cumulative_pct', 'category']));

    const report = (await request(app).get('/inventory/inventory-report').query({ type: 'abc_analysis' })).body;
    expect(report.type).toBe('abc_analysis');
    expect(Object.keys(report.rows[0])).toEqual(expect.arrayContaining(
      ['item_code', 'item_name', 'unit_of_measure', 'annual_value', 'cumulative_pct', 'abc_class']));

    const dept = (await request(app).get('/inventory/dept-cost-analysis')).body;
    expect(dept.config).toBeDefined();
    const p1 = dept.consolidated.items.find(i => i.item_code === `${TAG}-${A}-P1`);
    // The store EOQ maths is untouched: sqrt(2DS/H) on 12 months of demand.
    const H = 800 * dept.config.holding_cost_rate_annual;
    expect(p1.annual_demand).toBe(120);
    expect(p1.eoq).toBeCloseTo(Math.sqrt((2 * 120 * dept.config.ordering_cost) / H), 1);
    expect(dept.consolidated.totals.abc.A.count).toBeGreaterThanOrEqual(1);
    // An item the engine could not classify is counted as unclassified, not C.
    expect(dept.consolidated.totals.abc.Unclassified.count).toBe(1);   // STALEP
    expect(dept.consolidated.items.find(i => i.item_code === `${TAG}-${A}-STALEP`).abc_category).toBeNull();
  });

  // 11
  it('never serves the old cached analysis', async () => {
    const analysis = (await request(app).get('/inventory/abc-analysis')).body;
    expect(analysis.items.find(i => i.item_code === 'CACHED')).toBeUndefined();
    expect(analysis.unclassified_count).toBe(1);                      // STALEP
  });

  it('"Run Analysis" runs the planning recompute and returns its answer', async () => {
    const before = (await pool.query(`SELECT COUNT(*)::int n FROM inventory_planning_runs WHERE company_id = $1`, [A])).rows[0].n;
    const res = await request(app).post('/inventory/abc-analysis/run');
    expect(res.status).toBe(200);
    expect(res.body.run_no).toMatch(/^IPL-/);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM inventory_planning_runs WHERE company_id = $1`, [A])).rows[0].n)
      .toBe(before + 1);
    expect(new Map(res.body.items.map(i => [i.item_code, i.category]))).toEqual(
      new Map((await request(app).get('/inventory/abc-analysis')).body.items.map(i => [i.item_code, i.category])));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('thresholds: one source, validated, and they move the classification', () => {
  let app;
  beforeAll(() => { app = appAs(A); });

  it('reports the unapplied legacy cutoffs instead of adopting or dropping them', async () => {
    const res = await request(app).get('/inventory/planning/settings');
    expect(res.body.legacy_inventory_settings).toMatchObject({ abc_a_threshold: 20, abc_b_threshold: 30, applied: false });
    expect(Number(res.body.abc_a_threshold_pct)).toBe(70);
  });

  it('Inventory Settings shows the cutoffs the engine actually uses', async () => {
    const res = await request(app).get('/settings/inventory');
    expect([res.body.abc_a_threshold, res.body.abc_b_threshold]).toEqual([70, 90]);
    expect(res.body.slow_mover_days).toBe(90);                        // the rest of the blob is untouched
  });

  // 8
  it('rejects invalid or contradictory thresholds and writes nothing', async () => {
    const bad = [
      { abc_a_threshold_pct: 95 },                                    // above the stored B (90)
      { abc_a_threshold_pct: 0 },
      { abc_b_threshold_pct: 101 },
      { abc_a_threshold_pct: 'seventy' },
      { xyz_x_max_cv: 2 },                                            // above Y (1.0)
      { fsn_slow_days: 200 },                                         // above non-moving (180)
      { fsn_slow_days: 10.5 },
    ];
    for (const body of bad) {
      const res = await request(app).put('/inventory/planning/settings').send(body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      expect(res.body.message).toBeTruthy();
    }
    await expect(planning.updatePlanningSettings(A, { abc_a_threshold_pct: 90, abc_b_threshold_pct: 80 }))
      .rejects.toMatchObject({ status: 400 });

    const viaSettings = await request(app).post('/settings/inventory')
      .send({ abc_a_threshold: 95, abc_b_threshold: 90, slow_mover_days: 12 });
    expect(viaSettings.status).toBe(400);
    expect(viaSettings.body.message).toMatch(/lower than the B threshold/);

    expect(await settingsOf(A)).toMatchObject({ a: 70, b: 90, fsn_slow_days: 90, fsn_nonmoving_days: 180 });
    expect(await blobOf(A)).toEqual({ abc_a_threshold: 20, abc_b_threshold: 30, slow_mover_days: 90 }); // rolled back
  });

  // 3 + 11
  it('a saved threshold is the one the engine uses, and the next run reflects it', async () => {
    const res = await request(app).post('/settings/inventory')
      .send({ abc_a_threshold: 80, abc_b_threshold: 90, slow_mover_days: 60 });
    expect(res.status).toBe(200);
    expect(await settingsOf(A)).toMatchObject({ a: 80, b: 90 });
    expect(await blobOf(A)).toEqual({ slow_mover_days: 60 });         // no second copy of the cutoffs
    expect((await request(app).get('/inventory/planning/settings')).body.legacy_inventory_settings).toBeNull();
    expect((await auditRows('inventory_planning_settings', A, A)).length).toBeGreaterThanOrEqual(1);

    await planning.recomputePlanningParameters({ companyId: A, apply: true });
    // P2 starts at 79.21% cumulative: B under 70, A under 80.
    expect(cls((await row(item.P2)).abc_class)).toBe('A');
    const analysis = (await request(app).get('/inventory/abc-analysis')).body;
    expect(analysis.items.find(i => i.item_code === `${TAG}-${A}-P2`).category).toBe('A');
  }, 20_000);

  // 5 (second half) + 9
  it('a pin equal to the old calculation holds when the calculation moves', async () => {
    await request(app).put('/inventory/planning/settings').send({ abc_b_threshold_pct: 100 }).expect(200);
    await recalcCompany(A);
    const meq = await row(item.MEQ);
    expect(meq.abc_class_calculated).toBe('B');                       // under B = 100 there is no C
    expect([cls(meq.abc_class), meq.abc_class_source]).toEqual(['C', 'manual']);
    const leg = await row(item.LEG);                                  // engine-owned: follows the calculation
    expect([cls(leg.abc_class), leg.abc_class_calculated]).toEqual(['B', 'B']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('insufficient history: no stale figure presented as a calculation', () => {
  // 12
  it('clears every demand-derived figure and keeps the operative cover', async () => {
    const r = await row(item.STALEP);
    for (const col of ['eoq', 'safety_stock_calculated', 'reorder_point_calculated', 'annual_demand',
                       'avg_daily_demand', 'demand_stddev', 'annual_consumption_value',
                       'planning_params_computed_at', 'abc_class_calculated']) {
      expect([col, r[col]]).toEqual([col, null]);
    }
    expect(Number(r.safety_stock)).toBe(7);
    expect(Number(r.reorder_level)).toBe(9);
    expect(r.abc_class).toBeNull();                                   // it was engine-owned
    expect(r.classification_reason).toBe('insufficient_history');
  });

  it('labels the kept cover as having no current calculation behind it', async () => {
    const res = await request(appAs(A)).get('/inventory/planning/parameters');
    const p = res.body.find(i => i.id === item.STALEP);
    expect([p.safety_stock_basis, p.reorder_point_basis]).toEqual(['no_current_calculation', 'no_current_calculation']);
    const p1 = res.body.find(i => i.id === item.P1);
    expect([p1.safety_stock_basis, p1.reorder_point_basis]).toEqual(['calculated', 'calculated']);
  });

  // 13
  it('procurement still prices an item whose consumption value is gone', async () => {
    const res = await request(appAs(A)).get('/procurement/analytics/eoq').query({ item_id: item.STALEP });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('insufficient_history');
    expect(res.body.eoq).toBeNull();
    expect([res.body.unit_cost, res.body.unit_cost_source]).toEqual([25, 'standard_cost']);

    const gov = await request(appAs(A)).get('/procurement/analytics/eoq').query({ item_id: item.P1 });
    expect(gov.body.source).toBe('governed');
    expect(gov.body.unit_cost).toBe(800);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('tenant isolation', () => {
  // 10
  it("nothing company A did reached company B's items, settings or blob", async () => {
    const b = await row(item.BMAN);
    expect([cls(b.abc_class), b.abc_class_calculated, b.abc_class_source]).toEqual(['B', 'C', 'manual']);
    expect(b.classified_at).toBeNull();
    expect(await settingsOf(B)).toMatchObject({ a: 70, b: 90 });
    expect(await blobOf(B)).toEqual({ abc_a_threshold: 50, abc_b_threshold: 60, slow_mover_days: 45 });
  });

  it('company A cannot pin, clear or edit company B\'s class', async () => {
    const app = appAs(A);
    await request(app).put(`/inventory/planning/parameters/${item.BMAN}`).send({ abc_class: 'A' }).expect(404);
    await request(app).put(`/inventory/planning/parameters/${item.BMAN}`).send({ abc_class: null }).expect(404);
    await request(app).put(`/inventory/items/${item.BMAN}`)
      .send({ item_name: 'hijack', unit_of_measure: 'NOS', abc_class: 'C' }).expect(404);
    const b = await row(item.BMAN);
    expect([cls(b.abc_class), b.abc_class_source, b.item_name]).toEqual(['B', 'manual', `${TAG} BMAN`]);
    const analysis = (await request(app).get('/inventory/abc-analysis')).body;
    expect(analysis.items.find(i => i.item_id === item.BMAN)).toBeUndefined();
  });

  it("company B's own run honours its own manual class (positive pair)", async () => {
    await recalcCompany(B);
    const b = await row(item.BMAN);
    expect([cls(b.abc_class), b.abc_class_calculated, b.abc_class_source]).toEqual(['B', 'A', 'manual']);
    expect(b.classified_at).not.toBeNull();
  });
});
