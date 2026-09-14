/**
 * forecastEngine.js — the one place a sales forecast is computed.
 *
 * Pure of Express: every function takes explicit arguments and a pg client or
 * pool, so the routes stay thin and the engine is directly unit-testable
 * (src/__tests__/forecastEngine.test.js drives it with no HTTP layer).
 *
 * WHAT A FORECAST CATEGORY IS
 * ---------------------------
 * A forecast category is a PERSON'S judgement about a deal, not a restatement
 * of its stage. The two are related but not the same: a deal can sit in
 * Negotiation and still be a rep's strongest commit, and another can sit in the
 * same stage and be one they would rather not count.
 *
 * So `opportunities.forecast_category` is nullable and this module never writes
 * a default into the table. When it is NULL, deriveCategory() supplies one from
 * stage + probability so an uncategorised pipeline still forecasts; the moment
 * someone sets a category explicitly it is honoured and never overwritten. That
 * distinction is why the derivation lives here rather than in a column DEFAULT
 * — a column default would make "nobody has judged this yet" indistinguishable
 * from "someone judged it Pipeline", and those must stay tellable apart.
 *
 * THE CATEGORIES
 *   commit     — the rep is standing behind it. Counted at full value.
 *   best_case  — upside; real, but not promised.
 *   pipeline   — everything else still open.
 *   omitted    — deliberately excluded from the forecast (bad fit, stalled).
 *   closed     — already Won. Not a judgement; a fact.
 *
 * WEIGHTED vs UNWEIGHTED
 * Both are returned, always, and never mixed. The audit that produced this
 * module found the old endpoints reporting `SUM(expected_value * probability)`
 * under the bare label "forecast", which is a weighted number presented as if
 * it were a commitment. Callers get `amount` (unweighted) and
 * `weighted_amount` (probability-weighted) side by side and label them.
 */

import { sqlOpportunityWon, sqlOpportunityLost, sqlOpportunityClosed } from '../../../shared/statusSets.js';

export const FORECAST_CATEGORIES = ['commit', 'best_case', 'pipeline', 'omitted', 'closed'];

/** Categories that roll into the number a manager reports upward. */
export const FORECASTED_CATEGORIES = ['commit', 'best_case', 'pipeline'];

export const PERIOD_TYPES = ['monthly', 'quarterly', 'annual'];

/**
 * The default category for a deal nobody has categorised yet.
 *
 * Won deals are `closed` — a fact, not a judgement. Lost deals are `omitted`;
 * they must not vanish, because "what did we omit" is a question managers ask.
 * Open deals fall out of probability, which is itself seeded from
 * crm_pipeline_stages.probability when the stage changes.
 *
 * @param {string|null} stage
 * @param {number|null} probability  0-100
 * @returns {string} one of FORECAST_CATEGORIES
 */
export function deriveCategory(stage, probability) {
  const s = String(stage ?? '').trim().toLowerCase();
  if (s === 'won')  return 'closed';
  if (s === 'lost') return 'omitted';

  const p = Number(probability);
  if (!Number.isFinite(p)) return 'pipeline';
  if (p >= 75) return 'commit';
  if (p >= 50) return 'best_case';
  return 'pipeline';
}

/**
 * Resolve a period to the [start, end) date pair it covers.
 *
 * Kept as real dates rather than EXTRACT() predicates so the same bounds can be
 * shipped to the client. A period that renders an empty forecast is
 * indistinguishable from a broken query unless the caller can see the window it
 * was asked about — that ambiguity is exactly what made "No growth data" read
 * as a plausible empty state on the CEO growth window.
 *
 * @returns {{ start: string, end: string, label: string }} ISO dates, end exclusive
 */
export function periodBounds(periodType, periodYear, periodValue) {
  const year = parseInt(periodYear, 10);
  if (!Number.isInteger(year)) throw Object.assign(new Error('period_year must be an integer'), { status: 400 });
  if (!PERIOD_TYPES.includes(periodType)) {
    throw Object.assign(new Error(`period_type must be one of ${PERIOD_TYPES.join(', ')}`), { status: 400 });
  }

  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  if (periodType === 'annual') {
    return { start: iso(year, 1, 1), end: iso(year + 1, 1, 1), label: `CY ${year}` };
  }
  if (periodType === 'quarterly') {
    const q = parseInt(periodValue, 10);
    if (!(q >= 1 && q <= 4)) throw Object.assign(new Error('period_value must be 1-4 for a quarterly period'), { status: 400 });
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 3;
    return endMonth > 12
      ? { start: iso(year, startMonth, 1), end: iso(year + 1, 1, 1), label: `Q${q} ${year}` }
      : { start: iso(year, startMonth, 1), end: iso(year, endMonth, 1), label: `Q${q} ${year}` };
  }
  const m = parseInt(periodValue, 10);
  if (!(m >= 1 && m <= 12)) throw Object.assign(new Error('period_value must be 1-12 for a monthly period'), { status: 400 });
  return m === 12
    ? { start: iso(year, 12, 1), end: iso(year + 1, 1, 1), label: `${year}-12` }
    : { start: iso(year, m, 1), end: iso(year, m + 1, 1), label: `${year}-${String(m).padStart(2, '0')}` };
}

/**
 * The forecast for one period, broken down by category.
 *
 * Every category is present in the result even at zero. A category that
 * disappears when it is empty makes a real zero look like a missing feature,
 * and the caller then cannot tell "no committed deals" from "commit was never
 * computed".
 *
 * @param {import('pg').Pool} db
 * @param {object} opts
 * @param {number|null} opts.companyId   from companyOf(req) — null is a genuine global scope
 * @param {string} opts.periodType
 * @param {number} opts.periodYear
 * @param {number|null} opts.periodValue
 * @param {number|null} [opts.ownerEmployeeId] restrict to one rep's deals
 */
export async function computeForecast(db, { companyId, periodType, periodYear, periodValue, ownerEmployeeId = null }) {
  const { start, end, label } = periodBounds(periodType, periodYear, periodValue);

  // COALESCE the stored category with the derived one IN SQL so the grouping and
  // the drill-down agree by construction. Deriving in JS after the fact would
  // let a totals row and its own drill-down disagree, which is the failure mode
  // where a chip count exposes rows no chip can select.
  const { rows } = await db.query(
    `
    WITH scoped AS (
      SELECT
        o.id,
        COALESCE(o.expected_value, 0)                    AS value,
        COALESCE(o.probability_percentage, 0)            AS probability,
        COALESCE(
          o.forecast_category,
          CASE
            WHEN ${sqlOpportunityWon('o.stage')}  THEN 'closed'
            WHEN ${sqlOpportunityLost('o.stage')} THEN 'omitted'
            WHEN COALESCE(o.probability_percentage, 0) >= 75 THEN 'commit'
            WHEN COALESCE(o.probability_percentage, 0) >= 50 THEN 'best_case'
            ELSE 'pipeline'
          END
        )                                                AS category
      FROM opportunities o
      WHERE o.deleted_at IS NULL
        AND ($1::int IS NULL OR o.company_id = $1)
        AND o.expected_closing_date >= $2::date
        AND o.expected_closing_date <  $3::date
        AND ($4::int IS NULL OR o.assigned_to = $4)
    )
    SELECT category,
           COUNT(*)::int                                        AS opportunity_count,
           COALESCE(SUM(value), 0)                              AS amount,
           COALESCE(SUM(value * probability / 100.0), 0)        AS weighted_amount
      FROM scoped
     GROUP BY category
    `,
    [companyId, start, end, ownerEmployeeId]
  );

  const byCategory = Object.fromEntries(
    FORECAST_CATEGORIES.map((c) => [c, { category: c, opportunity_count: 0, amount: 0, weighted_amount: 0 }])
  );
  for (const r of rows) {
    byCategory[r.category] = {
      category: r.category,
      opportunity_count: Number(r.opportunity_count) || 0,
      amount: parseFloat(r.amount) || 0,
      weighted_amount: parseFloat(r.weighted_amount) || 0,
    };
  }

  const sum = (keys, field) => keys.reduce((t, k) => t + (byCategory[k]?.[field] ?? 0), 0);

  return {
    period: { period_type: periodType, period_year: Number(periodYear), period_value: periodValue == null ? null : Number(periodValue), label, start, end },
    owner_employee_id: ownerEmployeeId,
    categories: FORECAST_CATEGORIES.map((c) => byCategory[c]),
    totals: {
      // Unweighted, i.e. "if every one of these lands, this is the money".
      commit:            byCategory.commit.amount,
      best_case:         byCategory.best_case.amount,
      pipeline:          byCategory.pipeline.amount,
      omitted:           byCategory.omitted.amount,
      closed:            byCategory.closed.amount,
      // The number a manager reports: commit + best case + open pipeline.
      forecast:          sum(FORECASTED_CATEGORIES, 'amount'),
      // The same set, probability-weighted. Never present this as `forecast`.
      weighted_forecast: sum(FORECASTED_CATEGORIES, 'weighted_amount'),
      opportunity_count: FORECAST_CATEGORIES.reduce((t, c) => t + byCategory[c].opportunity_count, 0),
    },
  };
}

/**
 * The opportunities behind one forecast category — the drill-down the brief
 * requires (forecast -> opportunities). Uses the identical COALESCE-derived
 * category expression as computeForecast so a total can always be opened.
 */
export async function forecastOpportunities(db, { companyId, periodType, periodYear, periodValue, category, ownerEmployeeId = null }) {
  if (!FORECAST_CATEGORIES.includes(category)) {
    throw Object.assign(new Error(`category must be one of ${FORECAST_CATEGORIES.join(', ')}`), { status: 400 });
  }
  const { start, end } = periodBounds(periodType, periodYear, periodValue);

  const { rows } = await db.query(
    `
    SELECT o.id, o.opportunity_name, o.stage, o.expected_value,
           o.probability_percentage, o.expected_closing_date,
           o.assigned_to, e.name AS owner_name,
           o.account_id, a.name AS account_name,
           o.next_step, o.forecast_category AS explicit_category,
           COALESCE(
             o.forecast_category,
             CASE
               WHEN ${sqlOpportunityWon('o.stage')}  THEN 'closed'
               WHEN ${sqlOpportunityLost('o.stage')} THEN 'omitted'
               WHEN COALESCE(o.probability_percentage, 0) >= 75 THEN 'commit'
               WHEN COALESCE(o.probability_percentage, 0) >= 50 THEN 'best_case'
               ELSE 'pipeline'
             END
           ) AS category,
           COALESCE(o.expected_value, 0) * COALESCE(o.probability_percentage, 0) / 100.0 AS weighted_value
      FROM opportunities o
      LEFT JOIN employees e ON e.id = o.assigned_to
      LEFT JOIN accounts   a ON a.id = o.account_id
     WHERE o.deleted_at IS NULL
       AND ($1::int IS NULL OR o.company_id = $1)
       AND o.expected_closing_date >= $2::date
       AND o.expected_closing_date <  $3::date
       AND ($4::int IS NULL OR o.assigned_to = $4)
    `,
    [companyId, start, end, ownerEmployeeId]
  );

  return rows
    .filter((r) => r.category === category)
    .sort((a, b) => (parseFloat(b.expected_value) || 0) - (parseFloat(a.expected_value) || 0));
}

/**
 * Forecast accuracy: what a snapshot predicted for a period vs what that period
 * actually closed Won.
 *
 * Deliberately measured against SNAPSHOTS, never against a live recomputation.
 * Recomputing the forecast for a finished period returns whatever the deals
 * became, so "accuracy" measured that way is always ~100% and means nothing.
 * A period with no snapshot returns accuracy_pct: null with a `reason`, rather
 * than a number — an unmeasurable metric must say so, not report a default.
 */
export async function forecastAccuracy(db, { companyId, periodType, periodYear, ownerEmployeeId = null }) {
  const { rows: snaps } = await db.query(
    `
    SELECT period_value,
           SUM(amount) FILTER (WHERE forecast_category = 'commit')    AS commit_amount,
           SUM(amount) FILTER (WHERE forecast_category IN ('commit','best_case','pipeline')) AS forecast_amount,
           MIN(captured_at) AS first_captured_at
      FROM sales_forecast_snapshots
     WHERE ($1::int IS NULL OR company_id = $1)
       AND period_type = $2 AND period_year = $3
       AND ($4::int IS NULL OR owner_employee_id = $4)
     GROUP BY period_value
    `,
    [companyId, periodType, periodYear, ownerEmployeeId]
  );

  const { rows: actuals } = await db.query(
    `
    SELECT
      CASE $2
        WHEN 'monthly'   THEN EXTRACT(MONTH FROM COALESCE(o.closed_date, o.expected_closing_date))::int
        WHEN 'quarterly' THEN CEIL(EXTRACT(MONTH FROM COALESCE(o.closed_date, o.expected_closing_date)) / 3.0)::int
        ELSE NULL
      END AS period_value,
      COALESCE(SUM(o.expected_value), 0) AS actual_amount,
      COUNT(*)::int                       AS won_count
    FROM opportunities o
    WHERE o.deleted_at IS NULL
      AND ($1::int IS NULL OR o.company_id = $1)
      AND ${sqlOpportunityWon('o.stage')}
      AND EXTRACT(YEAR FROM COALESCE(o.closed_date, o.expected_closing_date)) = $3
      AND ($4::int IS NULL OR o.assigned_to = $4)
    GROUP BY 1
    `,
    [companyId, periodType, periodYear, ownerEmployeeId]
  );

  const actualBy = new Map(actuals.map((a) => [a.period_value == null ? null : Number(a.period_value), a]));
  const snapBy   = new Map(snaps.map((s) => [s.period_value == null ? null : Number(s.period_value), s]));
  const periods  = [...new Set([...actualBy.keys(), ...snapBy.keys()])].sort((a, b) => (a ?? 0) - (b ?? 0));

  return periods.map((pv) => {
    const snap = snapBy.get(pv);
    const act  = actualBy.get(pv);
    const forecastAmount = snap ? parseFloat(snap.forecast_amount) || 0 : null;
    const commitAmount   = snap ? parseFloat(snap.commit_amount)   || 0 : null;
    const actualAmount   = act  ? parseFloat(act.actual_amount)    || 0 : 0;

    let accuracyPct = null;
    let reason = null;
    if (forecastAmount == null) {
      reason = 'no forecast snapshot was captured for this period';
    } else if (forecastAmount === 0) {
      reason = 'the captured forecast for this period was zero';
    } else {
      // 100% when actual equals forecast; falls away symmetrically for over- and
      // under-forecasting, and floors at 0 rather than going negative.
      accuracyPct = Math.max(0, 100 - Math.abs(actualAmount - forecastAmount) / forecastAmount * 100);
      accuracyPct = Math.round(accuracyPct * 10) / 10;
    }

    return {
      period_value: pv,
      forecast_amount: forecastAmount,
      commit_amount: commitAmount,
      actual_amount: actualAmount,
      won_count: act ? Number(act.won_count) : 0,
      variance: forecastAmount == null ? null : actualAmount - forecastAmount,
      accuracy_pct: accuracyPct,
      snapshot_captured_at: snap?.first_captured_at ?? null,
      reason,
    };
  });
}

/**
 * The same roll-up as computeForecast, but broken out by owner in ONE query.
 *
 * The route used to call computeForecast() once per owner. That is an N+1: a
 * team of thirty reps meant thirty-one round trips for a single page load, and
 * it grows with headcount. The category expression here is character-identical
 * to computeForecast's, so a rep's row and the company total cannot disagree —
 * duplicating the CASE was the alternative and it is exactly how a total and its
 * own drill-down drift apart.
 *
 * Owners come from the opportunities themselves rather than the employee roster,
 * so a rep with deals always appears even if their `employees.status` has
 * drifted, and `assigned_to IS NULL` surfaces as a real "Unassigned" row instead
 * of being silently dropped.
 */
export async function forecastByOwner(db, { companyId, periodType, periodYear, periodValue }) {
  const { start, end, label } = periodBounds(periodType, periodYear, periodValue);

  const { rows } = await db.query(
    `
    WITH scoped AS (
      SELECT
        o.assigned_to                                    AS employee_id,
        COALESCE(o.expected_value, 0)                    AS value,
        COALESCE(o.probability_percentage, 0)            AS probability,
        COALESCE(
          o.forecast_category,
          CASE
            WHEN ${sqlOpportunityWon('o.stage')}  THEN 'closed'
            WHEN ${sqlOpportunityLost('o.stage')} THEN 'omitted'
            WHEN COALESCE(o.probability_percentage, 0) >= 75 THEN 'commit'
            WHEN COALESCE(o.probability_percentage, 0) >= 50 THEN 'best_case'
            ELSE 'pipeline'
          END
        )                                                AS category
      FROM opportunities o
      WHERE o.deleted_at IS NULL
        AND ($1::int IS NULL OR o.company_id = $1)
        AND o.expected_closing_date >= $2::date
        AND o.expected_closing_date <  $3::date
    )
    SELECT s.employee_id,
           e.name, e.designation,
           COUNT(*)::int                                                    AS opportunity_count,
           COALESCE(SUM(s.value) FILTER (WHERE s.category = 'commit'),    0) AS commit_amount,
           COALESCE(SUM(s.value) FILTER (WHERE s.category = 'best_case'), 0) AS best_case_amount,
           COALESCE(SUM(s.value) FILTER (WHERE s.category = 'pipeline'),  0) AS pipeline_amount,
           COALESCE(SUM(s.value) FILTER (WHERE s.category = 'omitted'),   0) AS omitted_amount,
           COALESCE(SUM(s.value) FILTER (WHERE s.category = 'closed'),    0) AS closed_amount,
           COALESCE(SUM(s.value)          FILTER (WHERE s.category IN ('commit','best_case','pipeline')), 0) AS forecast_amount,
           COALESCE(SUM(s.value * s.probability / 100.0)
                                          FILTER (WHERE s.category IN ('commit','best_case','pipeline')), 0) AS weighted_forecast
      FROM scoped s
      LEFT JOIN employees e ON e.id = s.employee_id
     GROUP BY s.employee_id, e.name, e.designation
     ORDER BY forecast_amount DESC
    `,
    [companyId, start, end]
  );

  const num = (v) => parseFloat(v) || 0;
  return {
    period: { period_type: periodType, period_year: Number(periodYear),
              period_value: periodValue == null ? null : Number(periodValue), label, start, end },
    data: rows.map((r) => ({
      employee_id: r.employee_id,
      name: r.employee_id == null ? 'Unassigned' : (r.name || `Employee ${r.employee_id}`),
      designation: r.designation ?? null,
      commit:            num(r.commit_amount),
      best_case:         num(r.best_case_amount),
      pipeline:          num(r.pipeline_amount),
      omitted:           num(r.omitted_amount),
      closed:            num(r.closed_amount),
      forecast:          num(r.forecast_amount),
      weighted_forecast: num(r.weighted_forecast),
      opportunity_count: Number(r.opportunity_count) || 0,
    })),
  };
}

export default {
  FORECAST_CATEGORIES,
  FORECASTED_CATEGORIES,
  PERIOD_TYPES,
  deriveCategory,
  periodBounds,
  computeForecast,
  forecastByOwner,
  forecastOpportunities,
  forecastAccuracy,
};
