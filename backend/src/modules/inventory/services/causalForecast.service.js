// backend/src/modules/inventory/services/causalForecast.service.js
//
// Causal (regression) demand forecasting, and the drivers it runs on.
//
// WHY THIS IS NOT "BLOCKED ON EXTERNAL DATA"
// ------------------------------------------
// The first remediation report listed causal forecasting as needing external
// demand drivers that Pulse does not ingest. That conflated two separable
// things: the regression, which is ordinary software, and the driver series,
// which needs a source. Pulse already holds two genuine leading indicators for a
// panel builder — the open opportunity pipeline and the tender pipeline — and
// both lead shipped demand by weeks or months. The drivers can be internal.
//
// A driver is registered once, its history is either synced from an internal
// source or entered, and an item's demand is then regressed against whichever
// drivers are attached to it.
//
// WHAT IT REFUSES TO DO
// ---------------------
// A regression will fit ANY series if you let it. Three guards, because a
// confident forecast from a meaningless fit is worse than no forecast:
//
//   * at least `minObs` aligned observations, and always more observations than
//     coefficients — otherwise the fit is arithmetic, not evidence;
//   * R-squared must clear a floor, or the driver is reported as not predictive
//     and the caller falls back to a time-series method;
//   * forecasting a future period needs a future DRIVER value. Extrapolating the
//     driver to forecast the demand is circular, so a period with no driver
//     value is simply not forecast.
//
// LAG is the point of a leading indicator: an opportunity won this month becomes
// demand in three months' time. `forecast_drivers.lag_periods` shifts the driver
// series forward by that many periods when aligning it with demand.

import pool from '../../../config/db.js';

const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v)) || 0;

/**
 * Ordinary least squares by Gaussian elimination on the normal equations.
 *
 * Fine for the handful of drivers this is ever asked to fit; a QR decomposition
 * would be more numerically stable but is unwarranted at k <= 5. Returns null
 * rather than NaNs when the system is singular — two perfectly collinear
 * drivers, for instance, which is a real thing to do by accident.
 *
 * @param {number[][]} X design matrix INCLUDING the intercept column
 * @param {number[]}   y observations
 */
export function olsFit(X, y) {
  const n = X.length;
  if (!n || X[0].length > n) return null;
  const k = X[0].length;

  // Normal equations: (X'X) b = X'y
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }

  // Gaussian elimination with partial pivoting.
  const M = XtX.map((row, i) => [...row, Xty[i]]);
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-10) return null;     // singular
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= k; c++) M[r][c] -= f * M[col][c];
    }
  }
  const beta = M.map((row, i) => row[k] / M[i][i]);
  if (beta.some(b => !Number.isFinite(b))) return null;

  // Goodness of fit. R-squared is reported, never used to decide silently.
  const yMean = y.reduce((s, v) => s + v, 0) / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = X[i].reduce((s, x, j) => s + x * beta[j], 0);
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
  // Adjusted R-squared penalises drivers that buy fit with degrees of freedom.
  const adjR2 = (r2 !== null && n > k) ? 1 - (1 - r2) * (n - 1) / (n - k) : null;

  return {
    beta,
    r_squared: r2 === null ? null : Math.round(r2 * 100000) / 100000,
    adj_r_squared: adjR2 === null ? null : Math.round(adjR2 * 100000) / 100000,
    n, k,
  };
}

/**
 * Fit demand against driver series and return a predictor.
 *
 * @param {number[]} demand              demand per period, oldest first
 * @param {Array<{id,code,name,lag,history:number[],future:number[]}>} drivers
 * @param {object}   opts  { minObs = 6, minR2 = 0.3 }
 */
export function fitCausal(demand, drivers, { minObs = 6, minR2 = 0.3, minCoverage = 0.6 } = {}) {
  if (!drivers?.length) return { ok: false, reason: 'no drivers attached to this item' };

  // Drop drivers that barely have any history BEFORE aligning.
  //
  // A period is usable only when EVERY driver has a value for it, so a single
  // sparse driver silently destroys the whole model: attaching one with 1 value
  // in 24 months left exactly one aligned observation and the fit was refused,
  // with a message blaming the observation count rather than the driver that
  // caused it. Excluding the sparse driver and saying so is both more robust and
  // more diagnosable than failing the fit it poisoned.
  const usableDrivers = [], droppedDrivers = [];
  for (const d of drivers) {
    const have = (d.history || []).filter(v => v !== null && v !== undefined && Number.isFinite(v)).length;
    const coverage = demand.length ? have / demand.length : 0;
    if (coverage >= minCoverage) usableDrivers.push(d);
    else droppedDrivers.push({ driver_code: d.code, coverage: Math.round(coverage * 100) / 100,
      reason: `only ${have} of ${demand.length} periods have a value` });
  }
  if (!usableDrivers.length) {
    return { ok: false, dropped: droppedDrivers,
      reason: `no driver has enough history (${droppedDrivers.map(d => d.driver_code).join(', ')})` };
  }
  drivers = usableDrivers;

  // Align: a driver with lag L explains demand L periods later, so demand[t] is
  // regressed on driver[t - L].
  const rows = [];
  const ys = [];
  for (let t = 0; t < demand.length; t++) {
    const xs = [1];
    let usable = true;
    for (const d of drivers) {
      const idx = t - (d.lag || 0);
      const v = idx >= 0 ? d.history[idx] : undefined;
      if (v === undefined || v === null || !Number.isFinite(v)) { usable = false; break; }
      xs.push(v);
    }
    if (!usable) continue;
    rows.push(xs);
    ys.push(demand[t]);
  }

  if (rows.length < Math.max(minObs, drivers.length + 2)) {
    return { ok: false, dropped: droppedDrivers,
      reason: `only ${rows.length} aligned observation(s) for ${drivers.length} driver(s)` };
  }

  const fit = olsFit(rows, ys);
  if (!fit) return { ok: false, reason: 'drivers are collinear or the fit is singular' };
  if (fit.r_squared === null || fit.r_squared < minR2) {
    return { ok: false, dropped: droppedDrivers, fit,
      reason: `drivers explain too little of the variation (R² ${fit.r_squared ?? 'n/a'})` };
  }

  /**
   * Predict horizon h (1-based). Needs a FUTURE driver value for that period;
   * extrapolating the driver in order to forecast the demand would be circular,
   * so an unavailable period returns null and the caller decides.
   */
  const predict = (h = 1) => {
    const xs = [1];
    for (const d of drivers) {
      // A lagged driver may already be KNOWN for a future period: with lag 3, the
      // value driving three months out was observed this month.
      const lag = d.lag || 0;
      let v;
      if (h <= lag) {
        const idx = d.history.length - 1 - (lag - h);
        v = idx >= 0 ? d.history[idx] : undefined;
      } else {
        v = d.future?.[h - lag - 1];
      }
      if (v === undefined || v === null || !Number.isFinite(v)) return null;
      xs.push(v);
    }
    const pred = xs.reduce((s, x, j) => s + x * fit.beta[j], 0);
    return Math.max(0, pred);
  };

  return {
    ok: true, predict, fit, dropped: droppedDrivers,
    coefficients: drivers.map((d, i) => ({
      driver_id: d.id, driver_code: d.code, driver_name: d.name,
      lag_periods: d.lag || 0,
      coefficient: Math.round(fit.beta[i + 1] * 1000000) / 1000000,
    })),
    intercept: Math.round(fit.beta[0] * 1000000) / 1000000,
    r_squared: fit.r_squared,
    adj_r_squared: fit.adj_r_squared,
    observations: fit.n,
  };
}

// ── Driver registry ──────────────────────────────────────────────────────────

export async function listDrivers(companyId) {
  const { rows } = await pool.query(
    `SELECT d.*, (SELECT COUNT(*)::int FROM forecast_driver_values v WHERE v.driver_id = d.id) AS value_count,
            (SELECT MAX(period_start) FROM forecast_driver_values v WHERE v.driver_id = d.id) AS latest_period
       FROM forecast_drivers d
      WHERE ($1::int IS NULL OR d.company_id = $1)
      ORDER BY d.driver_name`, [companyId]);
  return rows;
}

export async function upsertDriver(companyId, body = {}) {
  const { driver_code, driver_name, description, source_type, unit, lag_periods, is_active } = body;
  if (!driver_code || !driver_name) throw new Error('driver_code and driver_name are required');
  const { rows: [row] } = await pool.query(`
    INSERT INTO forecast_drivers (company_id, driver_code, driver_name, description, source_type, unit, lag_periods, is_active)
    VALUES ($1,$2,$3,$4,COALESCE($5,'manual'),$6,COALESCE($7,0),COALESCE($8,true))
    ON CONFLICT (company_id, driver_code) DO UPDATE
      SET driver_name = EXCLUDED.driver_name, description = EXCLUDED.description,
          source_type = EXCLUDED.source_type, unit = EXCLUDED.unit,
          lag_periods = EXCLUDED.lag_periods, is_active = EXCLUDED.is_active
    RETURNING *`,
    [companyId, driver_code, driver_name, description ?? null, source_type ?? null,
     unit ?? null, lag_periods ?? null, is_active ?? null]);
  return row;
}

export async function setDriverValues(driverId, companyId, values = []) {
  let n = 0;
  for (const v of values) {
    if (!v.period_start || v.value === undefined) continue;
    await pool.query(`
      INSERT INTO forecast_driver_values (driver_id, company_id, period_start, value, is_actual)
      VALUES ($1,$2,$3,$4,COALESCE($5,true))
      ON CONFLICT (driver_id, period_start) DO UPDATE
        SET value = EXCLUDED.value, is_actual = EXCLUDED.is_actual`,
      [driverId, companyId, v.period_start, v.value, v.is_actual ?? null]);
    n++;
  }
  return { upserted: n };
}

/**
 * Refresh the two drivers Pulse can populate from its own data.
 *
 * Both are LEADING indicators for a panel builder: pipeline value this month is
 * shipped demand some months later, which is exactly what a lagged regression is
 * for. Past periods are actuals; the current period is marked not-actual because
 * it is still accumulating.
 */
export async function syncInternalDrivers(companyId, { lookbackMonths = 36 } = {}) {
  const ensure = async (code, name, desc, lag, unit) =>
    upsertDriver(companyId, { driver_code: code, driver_name: name, description: desc,
      source_type: 'internal', lag_periods: lag, unit });

  const out = [];

  // 1. Open opportunity value by month created.
  try {
    const d = await ensure('OPP_PIPELINE', 'Opportunity pipeline value',
      'Total expected value of opportunities created in the period. Leads shipped demand.', 3, 'INR');
    const { rows } = await pool.query(`
      SELECT date_trunc('month', COALESCE(created_at, expected_closing_date))::date AS period_start,
             COALESCE(SUM(expected_value),0)::numeric AS value
        FROM opportunities
       WHERE ($1::int IS NULL OR company_id = $1) AND deleted_at IS NULL
         AND COALESCE(created_at, expected_closing_date) >= CURRENT_DATE - ($2 || ' months')::interval
       GROUP BY 1 ORDER BY 1`, [companyId, lookbackMonths]);
    const thisMonth = new Date(); thisMonth.setDate(1);
    await setDriverValues(d.id, companyId, rows.map(r => ({
      period_start: r.period_start, value: num(r.value),
      is_actual: new Date(r.period_start) < thisMonth,
    })));
    out.push({ driver: d.driver_code, periods: rows.length });
  } catch (e) { out.push({ driver: 'OPP_PIPELINE', error: e.message }); }

  // 2. Tender pipeline value by month.
  try {
    const d = await ensure('TENDER_PIPELINE', 'Tender pipeline value',
      'Total value of tenders submitted in the period. Leads shipped demand.', 4, 'INR');
    // There is no `tenders` table: a tender in Pulse is an OPPORTUNITY carrying
    // tender fields, and tenders.routes.js identifies one by exactly this
    // predicate. Querying a table that does not exist would have been caught at
    // runtime only as a swallowed error reporting "no data" forever — which is
    // the failure mode the whole SCA audit was about.
    const { rows } = await pool.query(`
      SELECT date_trunc('month', COALESCE(o.submission_deadline, o.created_at::date))::date AS period_start,
             COALESCE(SUM(o.expected_value),0)::numeric AS value
        FROM opportunities o
       WHERE ($1::int IS NULL OR o.company_id = $1) AND o.deleted_at IS NULL
         AND (o.tender_number IS NOT NULL OR o.bid_type IS NOT NULL OR o.emd_amount IS NOT NULL)
         AND COALESCE(o.submission_deadline, o.created_at::date) >= CURRENT_DATE - ($2 || ' months')::interval
       GROUP BY 1 ORDER BY 1`, [companyId, lookbackMonths]);
    const thisMonth = new Date(); thisMonth.setDate(1);
    await setDriverValues(d.id, companyId, rows.map(r => ({
      period_start: r.period_start, value: num(r.value),
      is_actual: new Date(r.period_start) < thisMonth,
    })));
    out.push({ driver: d.driver_code, periods: rows.length });
  } catch (e) {
    // The tenders table shape varies by deployment; a missing column must not
    // take the whole sync down with it.
    out.push({ driver: 'TENDER_PIPELINE', error: e.message });
  }

  return { drivers: out };
}

/** Attach or detach a driver from an item's demand model. */
export async function attachDriver(companyId, itemId, driverId) {
  const { rows: [row] } = await pool.query(`
    INSERT INTO item_demand_drivers (company_id, item_id, driver_id)
    VALUES ($1,$2,$3) ON CONFLICT (item_id, driver_id) DO UPDATE SET company_id = EXCLUDED.company_id
    RETURNING *`, [companyId, itemId, driverId]);
  return row;
}

export async function detachDriver(itemId, driverId) {
  await pool.query(`DELETE FROM item_demand_drivers WHERE item_id = $1 AND driver_id = $2`, [itemId, driverId]);
  return { detached: true };
}

/**
 * Load each item's attached drivers as period-aligned series.
 * @returns {Map<number, Array>} item_id -> drivers with history[] and future[]
 */
export async function loadItemDrivers(companyId, monthKeys, horizonKeys) {
  const { rows: links } = await pool.query(`
    SELECT idd.item_id, d.id, d.driver_code, d.driver_name, COALESCE(d.lag_periods,0) AS lag
      FROM item_demand_drivers idd
      JOIN forecast_drivers d ON d.id = idd.driver_id
     WHERE ($1::int IS NULL OR idd.company_id = $1) AND COALESCE(d.is_active,true) = true`, [companyId]);
  if (!links.length) return new Map();

  const driverIds = [...new Set(links.map(l => l.id))];
  const { rows: vals } = await pool.query(
    `SELECT driver_id, period_start::text AS period_start, value
       FROM forecast_driver_values WHERE driver_id = ANY($1::int[])`, [driverIds]);

  const byDriver = new Map();
  for (const v of vals) {
    if (!byDriver.has(v.driver_id)) byDriver.set(v.driver_id, new Map());
    byDriver.get(v.driver_id).set(v.period_start, num(v.value));
  }

  const out = new Map();
  for (const l of links) {
    const series = byDriver.get(l.id) || new Map();
    const entry = {
      id: l.id, code: l.driver_code, name: l.driver_name, lag: parseInt(l.lag, 10) || 0,
      history: monthKeys.map(k => series.has(k) ? series.get(k) : null),
      future: horizonKeys.map(k => series.has(k) ? series.get(k) : null),
    };
    if (!out.has(l.item_id)) out.set(l.item_id, []);
    out.get(l.item_id).push(entry);
  }
  return out;
}

export default {
  olsFit, fitCausal, listDrivers, upsertDriver, setDriverValues,
  syncInternalDrivers, attachDriver, detachDriver, loadItemDrivers,
};
