// backend/src/modules/inventory/services/demandForecast.service.js
//
// SKU-level statistical demand forecasting.
//
// WHY THIS IS NEW CODE RATHER THAN A CONNECTION
// ---------------------------------------------
// The 2026-09-11 SCA audit looked for demand forecasting and found exactly one
// forecasting engine in the product — sales/services/forecastEngine.js — which
// is good, careful work that forecasts REVENUE BY OPPORTUNITY. MRP needs
// QUANTITY BY SKU BY DATE. Opportunities carry no item lines, so there was
// nothing to adapt and no moving average, smoothing, seasonality or variability
// anywhere in the repository. demand_forecasts was a table behind a CRUD form.
//
// WHICH ITEMS GET FORECAST
// ------------------------
// Independent demand only. A component whose demand comes from exploding a
// parent's BOM must NOT also be forecast — that is double-counting, and it is
// the classic way an MRP implementation ends up ordering twice what it needs.
// Items that appear as a component on an active BOM are skipped with a reason.
//
// THE METHODS
//   moving_average  mean of the last k periods. Robust, no trend.
//   exp_smoothing   simple exponential smoothing, level only.
//   holt            double exponential smoothing: level + trend.
//   seasonal        multiplicative seasonal indices over a moving-average base.
//
// Method selection is a BACKTEST, not a preference: the last `holdout` periods
// are withheld, every eligible method forecasts them, and the one with the
// lowest MAPE on data it never saw is chosen. A method that needs more history
// than an item has is not eligible rather than being run on too little data.
//
// ACCURACY IS MEASURED ON CLOSED PERIODS ONLY, against what the model said at
// the time (forecast_qty), never against a number a planner has since edited.
// This mirrors the reasoning in forecastEngine.js: recomputing a finished period
// returns whatever happened, so accuracy measured that way is always ~100%.

import pool from '../../../config/db.js';
import causal from './causalForecast.service.js';

const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v)) || 0;
const r3 = (n) => Math.round(n * 1000) / 1000;
const nonNeg = (n) => (n > 0 ? n : 0);

/**
 * The first of a month, N months from now, as YYYY-MM-DD.
 *
 * Built from LOCAL date parts, never toISOString(). On any host east of UTC,
 * `new Date(); setDate(1); toISOString()` returns the LAST DAY OF THE PREVIOUS
 * MONTH — on an IST machine the 1st of September becomes "2026-08-31". SQL's
 * date_trunc('month', ...) returns a true first-of-month, so the two never
 * matched and every demand-history lookup silently found nothing.
 */
function monthKey(offset = 0) {
  const d = new Date();
  const y = d.getFullYear(), m = d.getMonth() + offset;
  const first = new Date(y, m, 1);
  const mm = String(first.getMonth() + 1).padStart(2, '0');
  return `${first.getFullYear()}-${mm}-01`;
}

/** Last day of the month that monthKey(offset) starts. */
function monthEndKey(offset = 0) {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() + offset + 1, 0);
  const mm = String(last.getMonth() + 1).padStart(2, '0');
  const dd = String(last.getDate()).padStart(2, '0');
  return `${last.getFullYear()}-${mm}-${dd}`;
}

// ── Forecast primitives ──────────────────────────────────────────────────────

export function movingAverage(series, k = 3) {
  if (series.length < 1) return null;
  const w = series.slice(-Math.min(k, series.length));
  return w.reduce((s, v) => s + v, 0) / w.length;
}

export function expSmoothing(series, alpha = 0.3) {
  if (!series.length) return null;
  let level = series[0];
  for (let i = 1; i < series.length; i++) level = alpha * series[i] + (1 - alpha) * level;
  return level;
}

/** Holt's linear trend. Returns a function of horizon h (1-based). */
export function holt(series, alpha = 0.3, beta = 0.1) {
  if (series.length < 2) return null;
  let level = series[0];
  let trend = series[1] - series[0];
  for (let i = 1; i < series.length; i++) {
    const prevLevel = level;
    level = alpha * series[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }
  return (h = 1) => level + h * trend;
}

/**
 * Multiplicative seasonal indices over a centred moving-average base.
 * Needs at least two full cycles or the indices are just noise.
 */
export function seasonalIndices(series, period = 12) {
  if (series.length < period * 2) return null;
  const base = movingAverage(series, period);
  if (!base || base <= 0) return null;
  const buckets = Array.from({ length: period }, () => []);
  series.forEach((v, i) => buckets[i % period].push(v));
  const idx = buckets.map(b => {
    if (!b.length) return 1;
    const mean = b.reduce((s, v) => s + v, 0) / b.length;
    return base > 0 ? mean / base : 1;
  });
  // Normalise so the indices average to 1 — otherwise they scale the forecast.
  const avg = idx.reduce((s, v) => s + v, 0) / idx.length;
  return avg > 0 ? idx.map(v => v / avg) : null;
}

// ── Accuracy ─────────────────────────────────────────────────────────────────

/** MAPE, MAD and bias for paired forecast/actual arrays. */
export function accuracy(forecasts, actuals) {
  const n = Math.min(forecasts.length, actuals.length);
  if (!n) return { mape: null, mad: null, bias: null, n: 0 };
  let absErr = 0, pctErr = 0, biasSum = 0, pctCount = 0;
  for (let i = 0; i < n; i++) {
    const e = forecasts[i] - actuals[i];
    absErr += Math.abs(e);
    biasSum += e;
    // A zero actual makes percentage error undefined, not infinite. Excluded
    // from MAPE and counted, so a series of zeros reports null rather than a
    // number built from divisions nobody performed.
    if (actuals[i] !== 0) { pctErr += Math.abs(e / actuals[i]); pctCount++; }
  }
  return {
    mape: pctCount ? Math.round((100 * pctErr / pctCount) * 100) / 100 : null,
    mad:  r3(absErr / n),
    bias: r3(biasSum / n),
    n,
  };
}

/**
 * Every method that has enough history, as {name, predict(h)}.
 *
 * `drivers` adds causal regression to the candidate set when an item has demand
 * drivers attached and they actually explain its variation. It competes in the
 * same backtest as everything else rather than being preferred for being
 * cleverer — a regression that loses to a three-period moving average should
 * lose.
 */
function eligibleMethods(series, seasonPeriod, drivers = null) {
  const out = [];
  if (series.length >= 2) out.push({ name: 'moving_average', predict: () => movingAverage(series, 3) });
  if (series.length >= 3) out.push({ name: 'exp_smoothing',  predict: () => expSmoothing(series, 0.3) });
  const h = series.length >= 4 ? holt(series) : null;
  if (h) out.push({ name: 'holt', predict: (k = 1) => h(k) });
  const idx = seasonalIndices(series, seasonPeriod);
  if (idx) {
    const base = holt(series) || (() => movingAverage(series, seasonPeriod));
    out.push({
      name: 'seasonal',
      predict: (k = 1) => num(base(k)) * num(idx[(series.length + k - 1) % seasonPeriod] ?? 1),
    });
  }
  if (drivers?.length) {
    // Trim each driver's history to the window this call is fitting, so a
    // backtest fits on training data only and does not see the held-out tail.
    const windowed = drivers.map(d => ({ ...d, history: d.history.slice(0, series.length) }));
    const fitted = causal.fitCausal(series, windowed);
    if (fitted.ok) {
      out.push({
        name: 'causal',
        // A period with no future driver value cannot be forecast causally.
        // Falling back to the trend is honest; inventing a driver value is not.
        predict: (k = 1) => {
          const v = fitted.predict(k);
          return v === null ? num(expSmoothing(series, 0.3)) : v;
        },
        meta: {
          r_squared: fitted.r_squared, adj_r_squared: fitted.adj_r_squared,
          coefficients: fitted.coefficients, intercept: fitted.intercept,
          observations: fitted.observations, dropped_drivers: fitted.dropped || [],
        },
      });
    }
  }
  return out;
}

/** Pick the method with the lowest MAPE on a withheld tail. */
function selectMethod(series, seasonPeriod, holdout, drivers = null) {
  const usableHoldout = Math.min(holdout, Math.max(0, series.length - 3));
  if (usableHoldout < 1) {
    const only = eligibleMethods(series, seasonPeriod, drivers);
    return { chosen: only[only.length - 1] || null, backtest: null, candidates: only.map(m => m.name) };
  }
  const train = series.slice(0, series.length - usableHoldout);
  const test  = series.slice(series.length - usableHoldout);
  const candidates = eligibleMethods(train, seasonPeriod, drivers);
  let best = null;
  const scores = [];
  for (const m of candidates) {
    const preds = [];
    for (let k = 1; k <= test.length; k++) preds.push(nonNeg(num(m.predict(k))));
    const acc = accuracy(preds, test);
    scores.push({ method: m.name, ...acc });
    // A method that cannot produce a MAPE (all-zero actuals) falls back to MAD
    // so it is still comparable rather than silently losing.
    const score = acc.mape ?? (acc.mad ?? Infinity);
    if (best === null || score < best.score) best = { name: m.name, score };
  }
  const full = eligibleMethods(series, seasonPeriod, drivers);
  return {
    chosen: full.find(m => m.name === best?.name) || full[full.length - 1] || null,
    backtest: scores,
    candidates: full.map(m => m.name),
  };
}

// ── History assembly ─────────────────────────────────────────────────────────

/**
 * Independent demand history per item, bucketed monthly.
 *
 * Customer orders are the demand signal for a finished good. Ledger consumption
 * is the fallback for anything sold without passing through a sales order. Both
 * exclude the seeding scripts' filler transaction types, which the audit
 * identified as fabricated rows and which would otherwise be read as history.
 */
async function loadHistory(client, companyId, lookbackDays) {
  const { rows: soRows } = await client.query(`
    SELECT soi.item_id,
           date_trunc('month', COALESCE(so.order_date, so.created_at))::date AS period,
           SUM(soi.quantity)::numeric AS qty
      FROM sales_order_items soi
      JOIN sales_orders so ON so.id = soi.order_id
     WHERE ($1::int IS NULL OR so.company_id = $1)
       AND so.deleted_at IS NULL
       AND soi.item_id IS NOT NULL
       AND LOWER(COALESCE(so.order_status,'')) <> 'cancelled'
       AND COALESCE(so.order_date, so.created_at::date) >= CURRENT_DATE - ($2 || ' days')::interval
     GROUP BY soi.item_id, 2`, [companyId, lookbackDays]);

  const { rows: slRows } = await client.query(`
    SELECT sl.item_id,
           date_trunc('month', sl.transaction_date)::date AS period,
           SUM(sl.quantity_out)::numeric AS qty
      FROM stock_ledger sl
     WHERE ($1::int IS NULL OR sl.company_id = $1)
       AND sl.quantity_out > 0
       AND sl.transaction_date >= CURRENT_DATE - ($2 || ' days')::interval
       AND LOWER(COALESCE(sl.transaction_type,'')) IN ('dispatch','sale','issue','consumption')
     GROUP BY sl.item_id, 2`, [companyId, lookbackDays]);

  const map = new Map();
  const add = (itemId, period, qty, source) => {
    if (!map.has(itemId)) map.set(itemId, { periods: new Map(), sources: new Set() });
    const e = map.get(itemId);
    e.periods.set(String(period), (e.periods.get(String(period)) || 0) + num(qty));
    e.sources.add(source);
  };
  for (const r of soRows) add(r.item_id, r.period, r.qty, 'sales_order');
  // Ledger rows only fill in for items with no order history, so a sale that
  // produced both an order line and a dispatch is not counted twice.
  for (const r of slRows) if (!soRows.some(s => s.item_id === r.item_id)) add(r.item_id, r.period, r.qty, 'stock_ledger');
  return map;
}

/** Item ids that are components on an active BOM — dependent demand. */
async function dependentDemandItems(client, companyId) {
  const { rows } = await client.query(`
    SELECT DISTINCT bl.component_id AS id
      FROM bom_lines bl JOIN bom_headers bh ON bh.id = bl.bom_id
     WHERE ($1::int IS NULL OR bh.company_id = $1 OR bh.company_id IS NULL)
       AND bh.status = 'active' AND bl.component_id IS NOT NULL`, [companyId]);
  return new Set(rows.map(r => r.id));
}

// ── The run ──────────────────────────────────────────────────────────────────

/**
 * Forecast every independent-demand item and write the results as draft
 * forecasts. Drafts, not approved: a forecast that silently becomes MRP input
 * without anyone agreeing to it is how a planning system loses its planners.
 */
export async function runDemandForecast({
  companyId = null, horizonPeriods = 6, lookbackDays = 730,
  method = 'auto', holdout = 3, seasonPeriod = 12, actor = {},
} = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const history   = await loadHistory(client, companyId, lookbackDays);
    const dependent = await dependentDemandItems(client, companyId);

    const { rows: items } = await client.query(`
      SELECT id, item_code, item_name, unit_of_measure
        FROM inventory_items
       WHERE ($1::int IS NULL OR company_id = $1)
         AND COALESCE(is_active,true) = true AND deleted_at IS NULL`, [companyId]);

    const periodsBack = Math.max(1, Math.round(lookbackDays / 30.44));
    const monthKeys = [];
    for (let i = periodsBack - 1; i >= 0; i--) monthKeys.push(monthKey(-i));
    // The periods being forecast, so a causal model can look up the driver value
    // that is supposed to explain each one.
    const horizonKeys = [];
    for (let h = 1; h <= horizonPeriods; h++) horizonKeys.push(monthKey(h));
    const driversByItem = await causal.loadItemDrivers(companyId, monthKeys, horizonKeys);

    const runNo = `FC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const { rows: [run] } = await client.query(`
      INSERT INTO demand_forecast_runs
        (company_id, run_no, method, bucket_type, horizon_periods, lookback_days, params,
         status, run_by, run_by_name)
      VALUES ($1,$2,$3,'month',$4,$5,$6,'running',$7,$8) RETURNING *`,
      [companyId, runNo, method, horizonPeriods, lookbackDays,
       JSON.stringify({ holdout, seasonPeriod }), actor.id ?? null, actor.name ?? 'System']);

    // Every previously GENERATED forecast for this scope is superseded — not
    // just the drafts.
    //
    // Restricting this to drafts was a double-counting bug: once a run's output
    // had been approved, the next run's rows were ADDED to it rather than
    // replacing it, so each regeneration inflated demand by a further full
    // horizon. A verification run caught it directly — four separate 23-unit
    // forecasts for the same month pegged against a single planned order.
    //
    // A forecast run is regenerative, exactly like MRP: its output replaces the
    // previous output. Manual overrides are excluded and survive, because those
    // represent a decision somebody made rather than a number a model produced.
    await client.query(`
      UPDATE demand_forecasts SET status = 'superseded', updated_at = NOW()
       WHERE ($1::int IS NULL OR company_id = $1)
         AND run_id IS NOT NULL
         AND COALESCE(is_manual_override,false) = false
         AND COALESCE(status,'draft') <> 'superseded'`, [companyId]);

    const out = [];
    let forecastCount = 0, skipped = 0;
    const mapes = [], mads = [], biases = [];

    for (const it of items) {
      if (dependent.has(it.id)) { skipped++; out.push({ item: it, skipped: 'dependent demand (BOM component)' }); continue; }
      const hist = history.get(it.id);
      if (!hist) { skipped++; out.push({ item: it, skipped: 'no demand history' }); continue; }

      const series = monthKeys.map(k => hist.periods.get(k) ?? 0);
      const observed = series.filter(v => v > 0).length;
      if (observed < 2) { skipped++; out.push({ item: it, skipped: `only ${observed} period(s) with demand` }); continue; }

      const itemDrivers = driversByItem.get(it.id) || null;
      let chosen, backtest = null, candidates = [];
      if (method === 'auto') {
        const sel = selectMethod(series, seasonPeriod, holdout, itemDrivers);
        chosen = sel.chosen; backtest = sel.backtest; candidates = sel.candidates;
      } else {
        chosen = eligibleMethods(series, seasonPeriod, itemDrivers).find(m => m.name === method) || null;
        candidates = [method];
      }
      if (!chosen) { skipped++; out.push({ item: it, skipped: `method ${method} needs more history` }); continue; }

      const best = backtest?.length
        ? backtest.reduce((a, b) => ((b.mape ?? Infinity) < (a.mape ?? Infinity) ? b : a))
        : null;
      if (best?.mape != null) mapes.push(best.mape);
      if (best?.mad  != null) mads.push(best.mad);
      if (best?.bias != null) biases.push(best.bias);

      const rows = [];
      for (let h = 1; h <= horizonPeriods; h++) {
        const periodStart = monthKey(h);
        const periodEnd   = monthEndKey(h);
        const qty = r3(nonNeg(num(chosen.predict(h))));

        const { rows: [saved] } = await client.query(`
          INSERT INTO demand_forecasts
            (company_id, item_id, product_name, forecast_date, quantity, consumed_qty, uom, source,
             run_id, method, forecast_qty, period_start, period_end, status, version,
             is_manual_override, created_by, created_by_name, notes)
          VALUES ($1,$2,$3,$4,$5,0,$6,'statistical',$7,$8,$9,$10,$11,'draft',1,false,$12,$13,$14)
          RETURNING id`,
          [companyId, it.id, it.item_name, periodStart, qty,
           it.unit_of_measure, run.id, chosen.name, qty,
           periodStart, periodEnd,
           actor.id ?? null, actor.name ?? 'System',
           `${chosen.name} over ${series.length} monthly periods`]);
        rows.push({ id: saved.id, period_start: periodStart, qty });
      }

      // A causal fit is worth keeping: the coefficient is the statement "one
      // more rupee of pipeline is this many units of demand", which a planner
      // can sanity-check in a way they cannot check a smoothing constant.
      if (chosen.meta?.coefficients) {
        for (const c of chosen.meta.coefficients) {
          await client.query(`
            INSERT INTO item_demand_drivers (company_id, item_id, driver_id, coefficient, r_squared, fitted_at)
            VALUES ($1,$2,$3,$4,$5,NOW())
            ON CONFLICT (item_id, driver_id) DO UPDATE
              SET coefficient = EXCLUDED.coefficient, r_squared = EXCLUDED.r_squared, fitted_at = NOW()`,
            [companyId, it.id, c.driver_id, c.coefficient, chosen.meta.r_squared]);
        }
      }

      forecastCount++;
      out.push({
        item: it, method: chosen.name, candidates, backtest,
        history: series, forecast: rows,
        mape: best?.mape ?? null, mad: best?.mad ?? null, bias: best?.bias ?? null,
        causal: chosen.meta ?? null,
      });
    }

    const avg = (a) => (a.length ? Math.round((a.reduce((s, v) => s + v, 0) / a.length) * 100) / 100 : null);
    const { rows: [done] } = await client.query(`
      UPDATE demand_forecast_runs
         SET items_evaluated = $2, items_forecast = $3, items_skipped = $4,
             avg_mape = $5, avg_mad = $6, avg_bias = $7, status = 'completed', completed_at = NOW()
       WHERE id = $1 RETURNING *`,
      [run.id, items.length, forecastCount, skipped, avg(mapes), avg(mads), avg(biases)]);

    await client.query('COMMIT');
    return { run: done, items: out };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Score closed periods: compare what each forecast predicted against what the
 * period actually consumed, and record it. Only periods whose end date has
 * passed are scored — an open period has no actual to compare against.
 */
export async function measureForecastAccuracy({ companyId = null } = {}) {
  const { rows: due } = await pool.query(`
    SELECT df.id, df.company_id, df.item_id, df.method, df.period_start, df.period_end,
           df.forecast_qty, ii.item_code, ii.item_name
      FROM demand_forecasts df
      JOIN inventory_items ii ON ii.id = df.item_id
     WHERE ($1::int IS NULL OR df.company_id = $1)
       AND df.period_end IS NOT NULL AND df.period_end < CURRENT_DATE
       AND df.forecast_qty IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM demand_forecast_accuracy a
          WHERE a.item_id = df.item_id AND a.period_start = df.period_start AND a.method = df.method)`,
    [companyId]);

  const written = [];
  for (const f of due) {
    const { rows: [act] } = await pool.query(`
      SELECT COALESCE(SUM(soi.quantity), 0)::numeric AS qty
        FROM sales_order_items soi JOIN sales_orders so ON so.id = soi.order_id
       WHERE soi.item_id = $1 AND so.deleted_at IS NULL
         AND LOWER(COALESCE(so.order_status,'')) <> 'cancelled'
         AND COALESCE(so.order_date, so.created_at::date) BETWEEN $2 AND $3`,
      [f.item_id, f.period_start, f.period_end]);

    const actual   = num(act.qty);
    const forecast = num(f.forecast_qty);
    const err      = forecast - actual;
    const pct      = actual !== 0 ? Math.round((100 * Math.abs(err / actual)) * 100) / 100 : null;

    await pool.query(`
      INSERT INTO demand_forecast_accuracy
        (company_id, item_id, item_code, item_name, method, period_start, period_end,
         forecast_qty, actual_qty, abs_error, pct_error, bias)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [f.company_id, f.item_id, f.item_code, f.item_name, f.method, f.period_start, f.period_end,
       forecast, actual, r3(Math.abs(err)), pct, r3(err)]);
    await pool.query(`UPDATE demand_forecasts SET actual_qty = $2 WHERE id = $1`, [f.id, actual]);
    written.push({ item_id: f.item_id, period_start: f.period_start, forecast, actual, pct_error: pct });
  }
  return { measured: written.length, rows: written };
}

/**
 * Consume forecast against a real order — the mechanism whose absence let
 * someone hand-set consumed_qty equal to quantity and zero out all MRP demand.
 * Idempotent per (forecast, source): re-running for the same order changes
 * nothing.
 */
export async function consumeForecast(client, { companyId, itemId, qty, sourceType, sourceId, sourceRef, date = new Date() }) {
  if (!itemId || num(qty) <= 0) return { consumed: 0 };
  const db = client || pool;
  const { rows: open } = await db.query(`
    SELECT id, quantity, consumed_qty
      FROM demand_forecasts
     WHERE ($1::int IS NULL OR company_id = $1)
       AND item_id = $2
       AND COALESCE(status,'draft') <> 'superseded'
       AND COALESCE(quantity,0) - COALESCE(consumed_qty,0) > 0
       AND (period_end IS NULL OR period_end >= $3::date)
     ORDER BY COALESCE(period_start, forecast_date) ASC`,
    [companyId, itemId, new Date(date).toISOString().slice(0, 10)]);

  let remaining = num(qty), consumed = 0;
  for (const f of open) {
    if (remaining <= 0) break;
    const avail = num(f.quantity) - num(f.consumed_qty);
    const take  = Math.min(avail, remaining);
    if (take <= 0) continue;
    const ins = await db.query(`
      INSERT INTO demand_forecast_consumption
        (company_id, forecast_id, item_id, qty, source_type, source_id, source_ref)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (forecast_id, source_type, source_id) WHERE source_id IS NOT NULL
      DO NOTHING RETURNING id`,
      [companyId, f.id, itemId, r3(take), sourceType, sourceId ?? null, sourceRef ?? null]);
    if (!ins.rows.length) continue;   // already consumed for this source
    await db.query(
      `UPDATE demand_forecasts SET consumed_qty = COALESCE(consumed_qty,0) + $2, updated_at = NOW() WHERE id = $1`,
      [f.id, r3(take)]);
    remaining -= take; consumed += take;
  }
  return { consumed: r3(consumed), unconsumed: r3(Math.max(0, remaining)) };
}

export default {
  runDemandForecast, measureForecastAccuracy, consumeForecast, accuracy,
  movingAverage, expSmoothing, holt, seasonalIndices,
};
