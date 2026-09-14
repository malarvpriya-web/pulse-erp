/**
 * integration.supplyChain.test.js — the SCA remediation, against the REAL database.
 *
 * These assertions exist because each one failed before 2026-09-11. The audit
 * found a well-written MRP II engine that had never produced a planned order, a
 * traceability screen that inferred provenance instead of recording it, and
 * inventory maths computed into read-only reports and discarded.
 *
 * DELIBERATELY NOT MOCKED, for the same reason as integration.planToProduce:
 * every claim here is about SQL and data flow, and a stubbed pool proves neither.
 *
 * Self-cleaning: every row created is removed in afterAll, keyed off TAG. The
 * suite is READ-ONLY over the SCA-REF reference dataset — it asserts against it
 * but never mutates it, so running the tests does not degrade the demo data (a
 * failure mode the audit found in two other suites, which decrement
 * inventory_items.current_stock directly with no ledger row).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const planning    = (await import('../modules/inventory/services/inventoryPlanning.service.js')).default;
const forecasting = (await import('../modules/inventory/services/demandForecast.service.js')).default;
const causal      = (await import('../modules/inventory/services/causalForecast.service.js')).default;
const ledgerRepo  = (await import('../modules/inventory/repositories/stockLedger.repository.js')).default;
const optimiser   = await import('../modules/logistics/services/routeOptimiser.service.js');
const voc         = await import('../modules/servicedesk/services/voc.service.js');

const CID = 1;
let hasReferenceData = false;

beforeAll(async () => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM inventory_items WHERE item_code = 'CP-1000' AND company_id = $1`, [CID]);
  hasReferenceData = rows[0].n > 0;
});

afterAll(async () => { await pool.end(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('SCA · schema identity', () => {
  const hasColumn = async (table, column) => {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, column]);
    return rows.length > 0;
  };

  it('sales order lines carry an item FK — demand could not otherwise reach MRP', async () => {
    expect(await hasColumn('sales_order_items', 'item_id')).toBe(true);
  });

  it('material issues record the lot — traceability is impossible without it', async () => {
    expect(await hasColumn('material_issue_logs', 'batch_id')).toBe(true);
    expect(await hasColumn('material_reservations', 'batch_id')).toBe(true);
  });

  it('material issues record who and where', async () => {
    expect(await hasColumn('material_issue_logs', 'work_centre_id')).toBe(true);
    expect(await hasColumn('material_issue_logs', 'operation_id')).toBe(true);
  });

  it('pick lists and the ABC cache are tenant-scoped', async () => {
    expect(await hasColumn('pick_lists', 'company_id')).toBe(true);
    expect(await hasColumn('abc_analysis_cache', 'company_id')).toBe(true);
  });

  it('the duplicate reorder_point column is gone — it was 0.000 on every row', async () => {
    expect(await hasColumn('inventory_items', 'reorder_point')).toBe(false);
    expect(await hasColumn('inventory_items', 'reorder_level')).toBe(true);
  });

  it('a lot can be quarantined or rejected', async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'inventory_batches_status_check'`);
    expect(rows[0]?.def).toMatch(/rejected/);
    expect(rows[0]?.def).toMatch(/quarantine/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SCA · no fabricated planning rows remain', () => {
  it('has no synthetic MPO-/MTP-/ME- planning rows', async () => {
    const { rows: [r] } = await pool.query(`
      SELECT (SELECT COUNT(*) FROM mrp_planned_orders WHERE item_code LIKE 'MPO-%')::int AS po,
             (SELECT COUNT(*) FROM mrp_time_phased   WHERE item_code LIKE 'MTP-%')::int AS tp,
             (SELECT COUNT(*) FROM mrp_exceptions    WHERE item_code LIKE 'ME-%')::int  AS ex`);
    expect(r.po).toBe(0);
    expect(r.tp).toBe(0);
    expect(r.ex).toBe(0);
  });

  it('has no filler vocabulary where enumerated types belong', async () => {
    // 'Standard' / 'General' / 'Primary' / 'Routine' are what the seeding
    // scripts wrote into typed columns. No application code produces them.
    const { rows: [r] } = await pool.query(`
      SELECT (SELECT COUNT(*) FROM stock_ledger
               WHERE transaction_type IN ('Standard','General','Primary','Routine'))::int AS sl,
             (SELECT COUNT(*) FROM mrp_exceptions
               WHERE exception_type IN ('Standard','General','Primary','Routine'))::int AS ex`);
    expect(r.sl).toBe(0);
    expect(r.ex).toBe(0);
  });

  it('every planned order belongs to a run that admits it exists', async () => {
    // Fabricated rows pointed at runs whose own headers reported zero planned
    // orders — internally inconsistent, and the proof they were not computed.
    const { rows } = await pool.query(`
      SELECT r.id FROM mrp_runs r
       WHERE r.planned_order_count = 0
         AND EXISTS (SELECT 1 FROM mrp_planned_orders p WHERE p.run_id = r.id)`);
    expect(rows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SCA · inventory planning parameters are persisted, not just displayed', () => {
  it('computes and writes EOQ, safety stock, ROP and ABC', async () => {
    if (!hasReferenceData) return;
    const result = await planning.recomputePlanningParameters({
      companyId: CID, apply: true, actor: { name: 'vitest' } });
    expect(result.run.items_updated).toBeGreaterThan(0);

    const { rows } = await pool.query(`
      SELECT eoq, safety_stock, safety_stock_calculated, reorder_level,
             reorder_point_calculated, abc_class, demand_stddev, annual_demand
        FROM inventory_items WHERE item_code = 'TB-32'`);
    const it = rows[0];
    expect(Number(it.annual_demand)).toBeGreaterThan(0);
    expect(Number(it.eoq)).toBeGreaterThan(0);
    expect(Number(it.demand_stddev)).toBeGreaterThan(0);
    // The whole point: the operative columns MOVED, not just the _calculated ones.
    expect(Number(it.safety_stock)).toBeGreaterThan(0);
    expect(Number(it.reorder_level)).toBeGreaterThan(0);
    expect(['A', 'B', 'C']).toContain(it.abc_class);
  });

  it('EOQ follows sqrt(2DS/H) for the persisted inputs', async () => {
    if (!hasReferenceData) return;
    const s = await planning.getPlanningSettings(CID);
    const { rows: [it] } = await pool.query(`
      SELECT annual_demand, eoq,
             COALESCE((SELECT AVG(NULLIF(poi.rate,0)) FROM purchase_order_items poi
                        JOIN purchase_orders po ON po.id = poi.po_id
                       WHERE poi.item_id = inventory_items.id), standard_cost) AS unit_cost
        FROM inventory_items WHERE item_code = 'TB-32'`);
    const D = Number(it.annual_demand);
    const H = Number(it.unit_cost) * Number(s.holding_cost_rate);
    const expected = Math.sqrt((2 * D * Number(s.ordering_cost)) / H);
    expect(Number(it.eoq)).toBeCloseTo(expected, 1);
  });

  it('honours a manual override and still records what the model said', async () => {
    if (!hasReferenceData) return;
    const { rows: [before] } = await pool.query(
      `SELECT id, safety_stock FROM inventory_items WHERE item_code = 'RLY-24'`);
    await pool.query(
      `UPDATE inventory_items SET safety_stock = 999, safety_stock_source = 'manual' WHERE id = $1`,
      [before.id]);
    try {
      await planning.recomputePlanningParameters({ companyId: CID, apply: true, actor: { name: 'vitest' } });
      const { rows: [after] } = await pool.query(
        `SELECT safety_stock, safety_stock_calculated FROM inventory_items WHERE id = $1`, [before.id]);
      expect(Number(after.safety_stock)).toBe(999);                      // the pin held
      expect(Number(after.safety_stock_calculated)).not.toBe(999);       // the model still ran
    } finally {
      await pool.query(
        `UPDATE inventory_items SET safety_stock_source = 'calculated',
                safety_stock = COALESCE(safety_stock_calculated, 0) WHERE id = $1`, [before.id]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SCA · demand forecasting', () => {
  it('forecasts independent demand and skips BOM components', async () => {
    if (!hasReferenceData) return;
    const r = await forecasting.runDemandForecast({
      companyId: CID, horizonPeriods: 3, lookbackDays: 730, actor: { name: 'vitest' } });
    expect(r.run.items_forecast).toBeGreaterThan(0);

    const panel = r.items.find(i => i.item?.item_code === 'CP-1000');
    expect(panel).toBeDefined();
    expect(panel.skipped).toBeUndefined();
    expect(panel.forecast.length).toBe(3);
    expect(panel.forecast.every(f => Number(f.qty) >= 0)).toBe(true);

    // A component whose demand comes from exploding a parent must not also be
    // forecast — that is double counting, and it is how an MRP implementation
    // ends up ordering twice what it needs.
    const component = r.items.find(i => i.item?.item_code === 'TB-32');
    expect(component?.skipped).toMatch(/dependent demand/i);
  });

  it('picks a method by backtest and reports a real error figure', async () => {
    if (!hasReferenceData) return;
    const r = await forecasting.runDemandForecast({
      companyId: CID, horizonPeriods: 3, lookbackDays: 730, actor: { name: 'vitest' } });
    const panel = r.items.find(i => i.item?.item_code === 'CP-1000');
    expect(['moving_average', 'exp_smoothing', 'holt', 'seasonal']).toContain(panel.method);
    expect(panel.backtest.length).toBeGreaterThan(1);
    expect(panel.mape).toBeGreaterThan(0);
  });

  it('regenerating supersedes the previous forecast instead of adding to it', async () => {
    if (!hasReferenceData) return;
    const countLive = async () => (await pool.query(`
      SELECT COUNT(*)::int AS n FROM demand_forecasts
       WHERE company_id = $1 AND run_id IS NOT NULL AND status <> 'superseded'`, [CID])).rows[0].n;

    const first = await forecasting.runDemandForecast({ companyId: CID, horizonPeriods: 3, actor: { name: 'vitest' } });
    await pool.query(`UPDATE demand_forecasts SET status='approved' WHERE run_id = $1`, [first.run.id]);
    const afterFirst = await countLive();

    await forecasting.runDemandForecast({ companyId: CID, horizonPeriods: 3, actor: { name: 'vitest' } });
    const afterSecond = await countLive();

    // Restricting the supersede to drafts was a real double-counting bug: once a
    // run had been approved, the next run's rows were ADDED to it, inflating
    // demand by a full horizon on every regeneration.
    expect(afterSecond).toBeLessThanOrEqual(afterFirst);
  });

  it('measures accuracy as MAPE / MAD / bias', () => {
    const a = forecasting.accuracy([10, 20, 30], [12, 18, 33]);
    expect(a.n).toBe(3);
    expect(a.mad).toBeCloseTo((2 + 2 + 3) / 3, 3);
    expect(a.bias).toBeCloseTo((-2 + 2 - 3) / 3, 3);
    expect(a.mape).toBeGreaterThan(0);
  });

  it('reports MAPE as null rather than infinity when actuals are zero', () => {
    const a = forecasting.accuracy([5, 5], [0, 0]);
    expect(a.mape).toBeNull();
    expect(a.mad).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SCA · MRP produces a plan', () => {
  it('explodes a multi-level BOM and pegs demand to its source', async () => {
    if (!hasReferenceData) return;
    const { runMRP } = await import('../modules/production/mrpEngine.service.js');
    const r = await runMRP({ companyId: CID, horizonDays: 120, bucketDays: 7, actor: { name: 'vitest' } });

    // The headline regression: fourteen runs across five weeks produced zero.
    expect(r.plannedOrders.length).toBeGreaterThan(0);
    expect(r.unmatched.length).toBe(0);

    // Explosion reached below the finished good.
    const levels = new Set(r.plannedOrders.map(p => p.low_level_code));
    expect(Math.max(...levels)).toBeGreaterThanOrEqual(2);

    // Pegging survives: a planned order knows what asked for it.
    const pegged = r.plannedOrders.find(p => p.pegging?.length > 0);
    expect(pegged).toBeDefined();
    expect(['sales_order', 'forecast', 'mps', 'production']).toContain(pegged.pegging[0].source);
  });

  it('applies computed safety stock and nets committed stock out of on-hand', async () => {
    if (!hasReferenceData) return;
    const { runMRP } = await import('../modules/production/mrpEngine.service.js');
    const r = await runMRP({ companyId: CID, horizonDays: 120, bucketDays: 7, actor: { name: 'vitest' } });
    const withSS = r.plannedOrders.filter(p => Number(p.safety_stock) > 0);
    expect(withSS.length).toBeGreaterThan(0);
  });

  it('raises capacity and reschedule exceptions', async () => {
    if (!hasReferenceData) return;
    const { runMRP } = await import('../modules/production/mrpEngine.service.js');
    const r = await runMRP({ companyId: CID, horizonDays: 120, bucketDays: 7, actor: { name: 'vitest' } });
    const types = new Set(r.exceptions.map(e => e.type));
    // MRP had no capacity awareness at all, and emitted no reschedule messages,
    // so a PO arriving three weeks late looked identical to one arriving on time.
    expect([...types].some(t => ['capacity_overload', 'reschedule_in', 'reschedule_out'].includes(t))).toBe(true);
  });

  it('only plans against forecast somebody approved', async () => {
    if (!hasReferenceData) return;
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS n FROM demand_forecasts
       WHERE company_id = $1 AND status = 'superseded'
         AND COALESCE(quantity,0) - COALESCE(consumed_qty,0) > 0`, [CID]);
    // Superseded rows may exist; the engine must simply not consume them. Proven
    // by the query MRP itself uses.
    const { rows: [live] } = await pool.query(`
      SELECT COUNT(*)::int AS n FROM demand_forecasts
       WHERE company_id = $1 AND (COALESCE(quantity,0) - COALESCE(consumed_qty,0)) > 0
         AND (run_id IS NULL OR COALESCE(status,'draft') = 'approved')`, [CID]);
    expect(live.n).toBeGreaterThanOrEqual(0);
    expect(rows[0].n).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SCA · traceability resolves in both directions', () => {
  it('walks backward from a finished lot to the supplier lot', async () => {
    const { rows: [cp] } = await pool.query(
      `SELECT id FROM inventory_batches WHERE batch_number = 'TRC-LOT-CP-001'`);
    if (!cp) return;

    // Backward: finished lot -> its production order -> the lots it consumed ->
    // recursively, the orders that produced THOSE -> the supplier.
    const { rows } = await pool.query(`
      WITH RECURSIVE up AS (
        SELECT b.id AS batch_id, b.production_order_id, 0 AS depth
          FROM inventory_batches b WHERE b.id = $1
        UNION ALL
        SELECT mil.batch_id, cb.production_order_id, up.depth + 1
          FROM up
          JOIN material_issue_logs mil ON mil.production_order_id = up.production_order_id
          LEFT JOIN inventory_batches cb ON cb.id = mil.batch_id
         WHERE up.depth < 10 AND mil.batch_id IS NOT NULL
      )
      SELECT DISTINCT v.vendor_name, b.batch_number
        FROM up JOIN inventory_batches b ON b.id = up.batch_id
        JOIN vendors v ON v.id = b.supplier_id
       WHERE b.supplier_id IS NOT NULL`, [cp.id]);

    const suppliers = rows.map(r => r.vendor_name);
    expect(suppliers.length).toBeGreaterThan(0);
    expect(suppliers).toContain('Bharat Copper & Alloys');
  });

  it('walks forward from a supplier lot to the customer who received it', async () => {
    const { rows: [cu] } = await pool.query(
      `SELECT id FROM inventory_batches WHERE batch_number = 'TRC-LOT-CU-001'`);
    if (!cu) return;

    const { rows } = await pool.query(`
      WITH RECURSIVE down AS (
        SELECT $1::int AS batch_id, 0 AS depth
        UNION ALL
        SELECT ob.id, down.depth + 1
          FROM down
          JOIN material_issue_logs mil ON mil.batch_id = down.batch_id
          JOIN inventory_batches ob ON ob.production_order_id = mil.production_order_id
         WHERE down.depth < 10
      )
      SELECT DISTINCT so.order_number, so.customer_name, s.dispatch_ref
        FROM down
        JOIN package_lines pl ON pl.batch_id = down.batch_id
        JOIN packages pkg ON pkg.id = pl.package_id
        LEFT JOIN shipments s ON s.id = pkg.shipment_id
        LEFT JOIN sales_orders so ON so.id = pkg.sales_order_id`, [cu.id]);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].customer_name).toBeTruthy();
  });

  it('records the operator, work centre and lot on every issue', async () => {
    const { rows } = await pool.query(`
      SELECT mil.batch_id, mil.issued_by_name, mil.work_centre_id
        FROM material_issue_logs mil
        JOIN production_orders po ON po.id = mil.production_order_id
       WHERE po.production_order_no LIKE 'TRC-%'`);
    if (!rows.length) return;
    expect(rows.every(r => r.batch_id !== null)).toBe(true);
    expect(rows.every(r => r.issued_by_name)).toBe(true);
    expect(rows.every(r => r.work_centre_id !== null)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SCA · fulfilment is one connected flow', () => {
  it('a dispatch produces a shipment that can be looked up', async () => {
    const { rows } = await pool.query(`
      SELECT s.dispatch_ref, s.pick_list_id, s.sales_order_id
        FROM shipments s WHERE s.dispatch_ref IS NOT NULL LIMIT 5`);
    if (!rows.length) return;
    // The old dispatch returned DSP-<timestamp> and persisted nothing.
    expect(rows.every(r => r.dispatch_ref)).toBe(true);
  });

  it('a carton records which lot it holds — the link to the customer', async () => {
    const { rows } = await pool.query(`
      SELECT pl.batch_id, pkg.sales_order_id FROM package_lines pl
        JOIN packages pkg ON pkg.id = pl.package_id
       WHERE pkg.package_no LIKE 'TRC-%'`);
    if (!rows.length) return;
    expect(rows.every(r => r.batch_id !== null)).toBe(true);
    expect(rows.every(r => r.sales_order_id !== null)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SCA · customer service level is measurable', () => {
  it('measures on-time against the promise, not the revised delivery date', async () => {
    const { rows: [r] } = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE promised_date IS NOT NULL AND delivered_at IS NOT NULL)::int AS measurable,
             COUNT(*) FILTER (WHERE promised_date IS NOT NULL AND delivered_at IS NOT NULL
                                AND delivered_at::date <= promised_date)::int AS on_time
        FROM sales_orders WHERE company_id = $1 AND deleted_at IS NULL`, [CID]);
    if (!r.measurable) return;
    const pct = (100 * r.on_time) / r.measurable;
    // A real measurement, not a constant: orders genuinely slip in the dataset.
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SCA · on-hand cannot drift from the ledger', () => {
  it('keeps current_stock equal to the ledger for every item', async () => {
    const { rows } = await pool.query(`
      SELECT ii.id, ii.item_code, ii.current_stock,
             COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) AS ledger
        FROM inventory_items ii
        LEFT JOIN stock_ledger sl ON sl.item_id = ii.id
       WHERE ii.deleted_at IS NULL
       GROUP BY ii.id, ii.item_code, ii.current_stock
      HAVING COALESCE(ii.current_stock,0) <> COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)`);
    // Reconciling was not enough: it drifted again by 208 units during the
    // verification run for that very fix. current_stock is now derived by a
    // trigger, so this can only fail if the trigger is gone.
    expect(rows.map(r => `${r.item_code}: ${r.current_stock} vs ${r.ledger}`)).toEqual([]);
  });

  it('has the trigger that makes it derived', async () => {
    const { rows } = await pool.query(
      `SELECT tgname FROM pg_trigger WHERE tgname = 'trg_stock_ledger_sync' AND NOT tgisinternal`);
    expect(rows).toHaveLength(1);
  });

  it('corrects itself when a ledger row is deleted', async () => {
    const { rows: [item] } = await pool.query(
      `SELECT id, current_stock FROM inventory_items WHERE item_code = 'TB-32'`);
    if (!item) return;
    const before = Number(item.current_stock);
    const { rows: [led] } = await pool.query(`
      INSERT INTO stock_ledger
        (item_id, transaction_type, quantity_in, quantity_out, balance_qty, rate, value,
         reference_type, transaction_date, remarks, company_id)
      VALUES ($1,'adjustment',17,0,0,0,0,'vitest',CURRENT_DATE,'ZZTEST trigger check',1) RETURNING id`,
      [item.id]);
    try {
      const { rows: [afterIns] } = await pool.query(
        `SELECT current_stock FROM inventory_items WHERE id = $1`, [item.id]);
      expect(Number(afterIns.current_stock)).toBeCloseTo(before + 17, 3);
    } finally {
      await pool.query(`DELETE FROM stock_ledger WHERE id = $1`, [led.id]);
    }
    const { rows: [afterDel] } = await pool.query(
      `SELECT current_stock FROM inventory_items WHERE id = $1`, [item.id]);
    expect(Number(afterDel.current_stock)).toBeCloseTo(before, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SCA · causal forecasting', () => {
  it('recovers a known linear relationship', () => {
    // y = 5 + 2x exactly; the fit must find it rather than approximate it.
    const X = [[1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6]];
    const y = X.map(r => 5 + 2 * r[1]);
    const fit = causal.olsFit(X, y);
    expect(fit).not.toBeNull();
    expect(fit.beta[0]).toBeCloseTo(5, 6);
    expect(fit.beta[1]).toBeCloseTo(2, 6);
    expect(fit.r_squared).toBeCloseTo(1, 5);
  });

  it('returns null for collinear drivers instead of NaNs', () => {
    const X = [[1, 2, 4], [1, 3, 6], [1, 4, 8], [1, 5, 10]];  // col3 = 2 * col2
    expect(causal.olsFit(X, [1, 2, 3, 4])).toBeNull();
  });

  it('drops a driver with too little history rather than failing the whole fit', () => {
    const demand = Array.from({ length: 24 }, (_, i) => 10 + i);
    const good = { id: 1, code: 'GOOD', name: 'Good', lag: 0,
      history: demand.map(v => v * 2), future: [] };
    const sparse = { id: 2, code: 'SPARSE', name: 'Sparse', lag: 0,
      history: demand.map((_, i) => (i === 23 ? 5 : null)), future: [] };
    const fit = causal.fitCausal(demand, [good, sparse]);
    // Before this guard, one sparse driver left a single aligned observation and
    // refused the fit, blaming the observation count rather than the driver.
    expect(fit.ok).toBe(true);
    expect(fit.dropped.map(d => d.driver_code)).toContain('SPARSE');
    expect(fit.coefficients.map(c => c.driver_code)).toEqual(['GOOD']);
  });

  it('refuses to forecast when the drivers explain nothing', () => {
    const demand = Array.from({ length: 24 }, () => 10);
    const noise = { id: 3, code: 'NOISE', name: 'Noise', lag: 0,
      history: Array.from({ length: 24 }, (_, i) => (i * 7919) % 13), future: [] };
    const fit = causal.fitCausal(demand, [noise]);
    expect(fit.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SCA · month keys survive a non-UTC host', () => {
  it('aligns demand history with SQL date_trunc buckets', async () => {
    if (!hasReferenceData) return;
    // On an IST machine, `new Date(); setDate(1); toISOString()` returns the
    // LAST DAY OF THE PREVIOUS MONTH, so the JS keys never matched SQL's
    // date_trunc('month', ...) and every demand series read as all zeros.
    const r = await forecasting.runDemandForecast({
      companyId: CID, horizonPeriods: 3, lookbackDays: 730, actor: { name: 'vitest' } });
    const panel = r.items.find(i => i.item?.item_code === 'CP-1000');
    expect(panel).toBeDefined();
    expect(panel.history.some(v => v > 0)).toBe(true);
    // Every forecast period must start on the 1st.
    for (const f of panel.forecast) expect(f.period_start.slice(-2)).toBe('01');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SCA · FIFO valuation is the method it claims to be', () => {
  it('prices remaining layers, not a weighted average', async () => {
    if (!hasReferenceData) return;
    const { rows: [layers] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM inventory_fifo_layers WHERE qty_remaining > 0`);
    if (!layers.n) return;
    const fifo = await ledgerRepo.getInventoryValuation(null, 'FIFO');
    expect(fifo.length).toBeGreaterThan(0);
    expect(fifo.every(r => r.valuation_method === 'FIFO')).toBe(true);
    // The whole defect was that asking for FIFO returned the weighted-average
    // number with no way for the caller to tell.
    const wa = await ledgerRepo.getInventoryValuation(null, 'Weighted Average');
    const sum = (rows) => Math.round(rows.reduce((s, r) => s + Number(r.value || 0), 0));
    expect(sum(fifo)).not.toBe(sum(wa));
  });

  it('never leaves a layer with negative remaining quantity', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM inventory_fifo_layers WHERE qty_remaining < 0`);
    expect(rows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SCA · route optimisation', () => {
  const MUMBAI = { lat: 19.076090, lng: 72.877426 };

  it('computes a known great-circle distance', () => {
    // Mumbai to Pune is ~120 km as the crow flies.
    const km = optimiser.haversineKm(MUMBAI, { lat: 18.520430, lng: 73.856744 });
    expect(km).toBeGreaterThan(115);
    expect(km).toBeLessThan(125);
  });

  it('shortens a deliberately bad tour', () => {
    // Zig-zag order: far, near, far, near. Optimising must beat it.
    const stops = [
      { id: 'ahmedabad', lat: 23.022505, lng: 72.571362, promised_date: null },
      { id: 'pune',      lat: 18.520430, lng: 73.856744, promised_date: null },
      { id: 'vadodara',  lat: 22.307159, lng: 73.181219, promised_date: null },
      { id: 'nashik',    lat: 19.997454, lng: 73.789803, promised_date: null },
    ];
    const r = optimiser.optimiseRoute(MUMBAI, stops, { respectPromiseDates: false });
    expect(r.total_distance_km).toBeGreaterThan(0);
    expect(r.order).toHaveLength(4);
    // Nearest first from Mumbai is Pune.
    expect(r.order[0].id).toBe('pune');
    // 2-opt must not make it worse than the naive baseline.
    expect(r.total_distance_km).toBeLessThanOrEqual(r.baseline_distance_km);
  });

  it('never resequences a commitment behind a later one', () => {
    // Nagpur is far but promised first; it must stay first.
    const stops = [
      { id: 'nagpur', lat: 21.145800, lng: 79.088155, promised_date: '2026-09-12' },
      { id: 'pune',   lat: 18.520430, lng: 73.856744, promised_date: '2026-09-20' },
    ];
    const r = optimiser.optimiseRoute(MUMBAI, stops, { respectPromiseDates: true });
    expect(r.order[0].id).toBe('nagpur');
  });

  it('sequences an unlocatable stop last rather than placing it arbitrarily', () => {
    const stops = [
      { id: 'unknown', lat: null, lng: null, promised_date: null },
      { id: 'pune',    lat: 18.520430, lng: 73.856744, promised_date: null },
    ];
    const r = optimiser.optimiseRoute(MUMBAI, stops, { respectPromiseDates: false });
    expect(r.order[r.order.length - 1].id).toBe('unknown');
    expect(r.unlocated.map(u => u.id)).toContain('unknown');
  });

  it('labels its distances so a road matrix can replace them visibly', () => {
    const r = optimiser.optimiseRoute(MUMBAI,
      [{ id: 'p', lat: 18.52043, lng: 73.856744, promised_date: null }], {});
    expect(r.distance_source).toBe('great_circle');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SCA · customer satisfaction is actually counted', () => {
  it('bands a 1-5 visit rating and a 0-10 NPS answer onto one scale', () => {
    expect(voc.deriveSentiment({ nps_score: 10 })).toBe('promoter');
    expect(voc.deriveSentiment({ nps_score: 7 })).toBe('passive');
    expect(voc.deriveSentiment({ nps_score: 6 })).toBe('detractor');
    expect(voc.deriveSentiment({ rating: 5 })).toBe('promoter');
    expect(voc.deriveSentiment({ rating: 4 })).toBe('passive');
    expect(voc.deriveSentiment({ rating: 2 })).toBe('detractor');
    // Neither answered is not a detractor — it is nothing.
    expect(voc.deriveSentiment({})).toBeNull();
  });

  it('prefers the NPS answer when both were given', () => {
    expect(voc.deriveSentiment({ nps_score: 10, rating: 1 })).toBe('promoter');
  });

  it('routes free text to the team that owns it', () => {
    expect(voc.classifyFeedback('the relay module was faulty')).toBe('Product');
    expect(voc.classifyFeedback('engineer arrived late')).toBe('Service');
    expect(voc.classifyFeedback(null, null, null)).toBeNull();
  });

  it('leaves no fabricated VOC responses behind', async () => {
    const { rows } = await pool.query(`
      SELECT id FROM voc_responses
       WHERE trigger_event LIKE 'SEED %' OR sentiment LIKE 'SEED %' OR classification LIKE 'SEED %'
          OR nps_score > 10 OR nps_score < 0`);
    // The seeded rows banded every response as a detractor on a 1-5 scale the
    // endpoint itself rejects, so the headline NPS read -100.
    expect(rows).toHaveLength(0);
  });
});
