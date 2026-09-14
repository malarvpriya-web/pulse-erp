// backend/src/modules/inventory/services/inventoryPlanning.service.js
//
// The one place EOQ, reorder point, safety stock and ABC are computed — and the
// only place they are WRITTEN BACK to the item master.
//
// WHY THIS SERVICE EXISTS
// -----------------------
// The 2026-09-11 SCA audit found all four already implemented, correctly, in
// three different read-only report endpoints — and discarded every time. Nothing
// in the codebase wrote abc_class, safety_stock or reorder_level from a
// calculation, so mrpEngine.service.js read the hand-typed fields instead:
// safety_stock 0.00 on every item, abc_class NULL on every item. The formulas
// were never the problem; having nowhere to put the answer was.
//
// The three former implementations also disagreed on unit cost — inventory used
// AVG(stock_ledger.rate), procurement used AVG(purchase_order_items.rate) — so
// two screens could legitimately show different EOQs for the same part. This is
// now the single source of truth and both callers read it.
//
// THE MATHS
//   D    annual demand         consumption over the lookback, annualised
//   d    average daily demand  D / 365
//   sigma_p  standard deviation of demand per PERIOD (monthly bucket)
//   sigma_d  sigma_p / sqrt(days_per_period)      — daily demand sigma
//   L    lead time (days)
//   z    service-level factor (95% -> 1.645)
//
//   Safety stock = z * sigma_d * sqrt(L)          — classic lead-time demand cover
//   ROP          = d * L + safety stock
//   EOQ          = sqrt(2 * D * S / H),  H = unit_cost * holding_rate
//   ABC          = Pareto on annual consumption value, A <= 70%, B <= 90%
//
// WHAT IT REFUSES TO DO
// ---------------------
// An item with fewer than `min_periods_for_stats` periods of history gets NULL
// parameters and a skip_reason, never a zero. A zero safety stock computed from
// no data is indistinguishable from a deliberate decision to hold none, and that
// ambiguity is exactly how the current 0.00-everywhere state came to look normal.
//
// Manual overrides survive. safety_stock_source / reorder_point_source say which
// figure MRP should honour; when either is 'manual' the planner's number is left
// alone and the calculated one is still stored alongside it so the two can be
// compared.

import pool from '../../../config/db.js';

const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v)) || 0;
const r3 = (n) => Math.round(n * 1000) / 1000;
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Service-level z for a target percentage, via an inverse-normal approximation
 * (Acklam). A lookup table was rejected: planners set 97.5% and 99.9% and a
 * table silently rounds those to the nearest tabulated row.
 */
export function zForServiceLevel(pct) {
  const p = Math.min(0.999999, Math.max(0.5, num(pct) / 100));
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, x;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    q = p - 0.5; const r = q * q;
    x = (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
        (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  return Math.round(x * 1000) / 1000;
}

/** Population standard deviation across period buckets. */
function stddev(values) {
  if (!values.length) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Resolve the company's planning policy, creating the default row on first use. */
export async function getPlanningSettings(companyId, client = pool) {
  if (companyId == null) {
    return { company_id: null, ordering_cost: 500, holding_cost_rate: 0.18,
             service_level_pct: 95, lookback_days: 365, min_periods_for_stats: 3, auto_apply: true };
  }
  const { rows } = await client.query(
    `SELECT * FROM inventory_planning_settings WHERE company_id = $1`, [companyId]);
  if (rows[0]) return rows[0];
  const { rows: [created] } = await client.query(
    `INSERT INTO inventory_planning_settings (company_id) VALUES ($1)
     ON CONFLICT (company_id) DO UPDATE SET updated_at = NOW() RETURNING *`, [companyId]);
  return created;
}

export async function updatePlanningSettings(companyId, patch = {}) {
  await getPlanningSettings(companyId);
  const allowed = ['ordering_cost', 'holding_cost_rate', 'service_level_pct',
                   'lookback_days', 'min_periods_for_stats', 'auto_apply'];
  const sets = [], vals = [companyId];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    vals.push(patch[k]);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) return getPlanningSettings(companyId);
  const { rows: [row] } = await pool.query(
    `UPDATE inventory_planning_settings SET ${sets.join(', ')}, updated_at = NOW()
      WHERE company_id = $1 RETURNING *`, vals);
  return row;
}

/**
 * Recompute every item's planning parameters and persist them.
 *
 * @param {object}  opts
 * @param {number?} opts.companyId
 * @param {boolean} opts.apply    false = dry run (compute + record, write nothing to items)
 * @returns {Promise<{run, items}>}
 */
export async function recomputePlanningParameters({ companyId = null, apply = null, actor = {} } = {}) {
  const settings = await getPlanningSettings(companyId);
  const orderingCost = num(settings.ordering_cost) || 500;
  const holdingRate  = num(settings.holding_cost_rate) || 0.18;
  const serviceLevel = num(settings.service_level_pct) || 95;
  const lookbackDays = parseInt(settings.lookback_days, 10) || 365;
  const minPeriods   = parseInt(settings.min_periods_for_stats, 10) || 3;
  const shouldApply  = apply === null ? settings.auto_apply !== false : Boolean(apply);
  const z            = zForServiceLevel(serviceLevel);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Items in scope ───────────────────────────────────────────────────────
    const { rows: items } = await client.query(`
      SELECT id, item_code, item_name, unit_of_measure,
             COALESCE(lead_time_days, 0)  AS lead_time_days,
             COALESCE(standard_cost, 0)   AS standard_cost,
             safety_stock, reorder_level,
             COALESCE(safety_stock_source,  'calculated') AS safety_stock_source,
             COALESCE(reorder_point_source, 'calculated') AS reorder_point_source
        FROM inventory_items
       WHERE ($1::int IS NULL OR company_id = $1)
         AND COALESCE(is_active, true) = true AND deleted_at IS NULL
       ORDER BY id`, [companyId]);

    // ── Consumption history, bucketed by month ───────────────────────────────
    // Transfers move stock between locations; they are not demand. 'Standard' /
    // 'General' / 'Primary' / 'Routine' are the filler vocabulary left by the
    // seeding scripts the audit identified — excluded so fabricated rows cannot
    // masquerade as consumption history.
    const { rows: consumption } = await client.query(`
      SELECT sl.item_id,
             date_trunc('month', sl.transaction_date)::date AS period,
             SUM(sl.quantity_out)::numeric                  AS qty,
             AVG(NULLIF(sl.rate, 0))                        AS avg_rate
        FROM stock_ledger sl
       WHERE ($1::int IS NULL OR sl.company_id = $1)
         AND sl.quantity_out > 0
         AND sl.transaction_date >= CURRENT_DATE - ($2 || ' days')::interval
         AND LOWER(COALESCE(sl.transaction_type, '')) NOT IN
             ('transfer', 'standard', 'general', 'primary', 'routine')
       GROUP BY sl.item_id, 2`, [companyId, lookbackDays]);

    const byItem = new Map();
    for (const c of consumption) {
      if (!byItem.has(c.item_id)) byItem.set(c.item_id, []);
      byItem.get(c.item_id).push({ period: c.period, qty: num(c.qty), rate: num(c.avg_rate) });
    }

    // ── Purchase price as the cost basis, standard cost as fallback ──────────
    const { rows: poRates } = await client.query(`
      SELECT poi.item_id, AVG(NULLIF(poi.rate, 0)) AS unit_cost
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.po_id
       WHERE ($1::int IS NULL OR po.company_id = $1) AND poi.item_id IS NOT NULL
       GROUP BY poi.item_id`, [companyId]);
    const costOf = new Map(poRates.map(r => [r.item_id, num(r.unit_cost)]));

    const periodsInLookback = Math.max(1, Math.round(lookbackDays / 30.44));
    const results = [];

    for (const it of items) {
      const hist = byItem.get(it.id) || [];
      const unitCost = costOf.get(it.id) || num(it.standard_cost) ||
                       (hist.find(h => h.rate > 0)?.rate ?? 0);

      if (hist.length < minPeriods) {
        results.push({ item: it, skip: `only ${hist.length} period(s) of history`,
                       annual_demand: null, eoq: null, safety_stock: null, rop: null,
                       abc: null, acv: 0, unit_cost: unitCost });
        continue;
      }

      // Absent months are genuine zero-demand months and must count toward the
      // variability: dropping them understates sigma for intermittent parts,
      // which is precisely where safety stock matters most.
      const qtyByPeriod = new Map(hist.map(h => [String(h.period), h.qty]));
      // Local date parts, never toISOString(): east of UTC the latter turns the
      // 1st of a month into the last day of the previous one, so these keys
      // would never match SQL's date_trunc('month', ...) and every series would
      // read as all zeros.
      const series = [];
      for (let i = 0; i < periodsInLookback; i++) {
        const now = new Date();
        const first = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-01`;
        series.push(qtyByPeriod.get(key) ?? 0);
      }

      const totalQty     = series.reduce((s, v) => s + v, 0);
      const annualDemand = totalQty * (365 / lookbackDays);
      const dailyDemand  = annualDemand / 365;
      const sigmaPeriod  = stddev(series);
      const sigmaDaily   = sigmaPeriod / Math.sqrt(365 / periodsInLookback);
      const meanPeriod   = totalQty / series.length;
      const cv           = meanPeriod > 0 ? sigmaPeriod / meanPeriod : null;

      const leadDays = parseInt(it.lead_time_days, 10) || 0;
      const safetyStock = z * sigmaDaily * Math.sqrt(Math.max(leadDays, 0));
      const rop         = dailyDemand * leadDays + safetyStock;

      const H   = unitCost * holdingRate;
      const eoq = annualDemand > 0 && H > 0
        ? Math.sqrt((2 * annualDemand * orderingCost) / H)
        : null;

      results.push({
        item: it, skip: null,
        annual_demand: r3(annualDemand),
        daily_demand:  Math.round(dailyDemand * 10000) / 10000,
        sigma_period:  Math.round(sigmaPeriod * 10000) / 10000,
        cv:            cv === null ? null : Math.round(cv * 10000) / 10000,
        periods:       series.length,
        eoq:           eoq === null ? null : r3(eoq),
        safety_stock:  r3(safetyStock),
        rop:           r3(rop),
        unit_cost:     r2(unitCost),
        acv:           r2(annualDemand * unitCost),
        abc:           null,
      });
    }

    // ── ABC: Pareto over annual consumption value ────────────────────────────
    const valued = results.filter(r => r.acv > 0).sort((a, b) => b.acv - a.acv);
    const grand  = valued.reduce((s, r) => s + r.acv, 0);
    let running = 0;
    for (const r of valued) {
      running += r.acv;
      const cum = grand > 0 ? (100 * running) / grand : 0;
      r.abc = cum <= 70 ? 'A' : cum <= 90 ? 'B' : 'C';
    }
    // Items with no consumption value are C: they are not "unclassified", they
    // are the tail. An item nobody consumes is the definition of a C part.
    for (const r of results) if (!r.abc) r.abc = 'C';

    // ── Persist ──────────────────────────────────────────────────────────────
    const runNo = `IPL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const counts = { A: 0, B: 0, C: 0 };
    for (const r of results) counts[r.abc] = (counts[r.abc] || 0) + 1;
    const updatedRows = results.filter(r => !r.skip);

    const { rows: [run] } = await client.query(`
      INSERT INTO inventory_planning_runs
        (company_id, run_no, lookback_days, ordering_cost, holding_cost_rate, service_level_pct,
         items_evaluated, items_updated, items_skipped, abc_a_count, abc_b_count, abc_c_count,
         total_annual_value, params, run_by, run_by_name, completed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW()) RETURNING *`,
      [companyId, runNo, lookbackDays, orderingCost, holdingRate, serviceLevel,
       results.length, shouldApply ? updatedRows.length : 0, results.length - updatedRows.length,
       counts.A || 0, counts.B || 0, counts.C || 0, r2(grand),
       JSON.stringify({ z, apply: shouldApply, min_periods: minPeriods }),
       actor.id ?? null, actor.name ?? 'System']);

    for (const r of results) {
      await client.query(`
        INSERT INTO inventory_planning_run_items
          (run_id, company_id, item_id, item_code, item_name, annual_demand, avg_daily_demand,
           demand_stddev, unit_cost, eoq, safety_stock, reorder_point, abc_class,
           annual_consumption_value, applied, skip_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [run.id, companyId, r.item.id, r.item.item_code, r.item.item_name,
         r.annual_demand, r.daily_demand ?? null, r.sigma_period ?? null, r.unit_cost,
         r.eoq, r.safety_stock, r.rop, r.abc, r.acv,
         shouldApply && !r.skip, r.skip]);

      if (!shouldApply || r.skip) continue;

      // Manual overrides are honoured: the calculated figure is always stored,
      // but the operative column is only moved when its source says calculated.
      await client.query(`
        UPDATE inventory_items SET
          annual_demand             = $2,
          avg_daily_demand          = $3,
          demand_stddev             = $4,
          demand_cv                 = $5,
          demand_periods_observed   = $6,
          eoq                       = $7,
          safety_stock_calculated   = $8,
          reorder_point_calculated  = $9,
          abc_class_calculated      = $10::text,
          annual_consumption_value  = $11,
          service_level_pct         = $12,
          service_level_z           = $13,
          abc_class                 = $10::text,
          safety_stock  = CASE WHEN COALESCE(safety_stock_source,'calculated')  = 'manual'
                               THEN safety_stock  ELSE $8 END,
          reorder_level = CASE WHEN COALESCE(reorder_point_source,'calculated') = 'manual'
                               THEN reorder_level ELSE $9 END,
          planning_params_computed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1`,
        [r.item.id, r.annual_demand, r.daily_demand, r.sigma_period, r.cv, r.periods,
         r.eoq, r.safety_stock, r.rop, r.abc, r.acv, serviceLevel, z]);
    }

    await client.query('COMMIT');
    return {
      run,
      items: results.map(r => ({
        item_id: r.item.id, item_code: r.item.item_code, item_name: r.item.item_name,
        annual_demand: r.annual_demand, avg_daily_demand: r.daily_demand ?? null,
        demand_stddev: r.sigma_period ?? null, demand_cv: r.cv ?? null,
        unit_cost: r.unit_cost, eoq: r.eoq, safety_stock: r.safety_stock,
        reorder_point: r.rop, abc_class: r.abc,
        annual_consumption_value: r.acv, skipped: Boolean(r.skip), skip_reason: r.skip,
      })),
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export default { recomputePlanningParameters, getPlanningSettings, updatePlanningSettings, zForServiceLevel };
