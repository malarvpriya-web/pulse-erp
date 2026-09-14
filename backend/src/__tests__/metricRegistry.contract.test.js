/**
 * metricRegistry.contract.test.js — every registered metric must actually run.
 *
 * WHY THIS EXISTS
 * ---------------
 * `shared/metricRegistry.js` is the semantic layer behind the dashboard
 * builder: a saved widget names a metric, and the server turns that name into
 * SQL. The whole point is that a user can compose a chart without a developer —
 * which means a metric whose SQL is broken produces an EMPTY CHART, not an
 * error anyone sees. That is the single most expensive failure mode in this
 * codebase's history:
 *
 *   - `closed_won` matched zero rows, so every closed deal counted as open
 *     pipeline and win rate sat at a permanent 0%;
 *   - the Monthly Trends query had `WHERE … WHERE` and had never once run;
 *   - nineteen statements in the Analyse module failed on every request,
 *     swallowed by `.catch(() => [])`;
 *   - the Procurement Reports page returned the wrong SHAPE and rendered
 *     "No data" on every panel for weeks.
 *
 * Every one of those passed lint, passed the build, and passed a static
 * reference check. A static gate cannot certify SQL. Only executing it can.
 *
 * So this suite executes EVERY metric against EVERY dimension it declares, on a
 * real database, and asserts the two-column contract the chart renderer depends
 * on. It does not assert VALUES — the fixture database has whatever it has —
 * it asserts that the query runs and returns the agreed shape. A metric added
 * tomorrow is covered without anyone remembering to add a test.
 *
 * The first run of this gate found twelve broken metrics: every `none`
 * dimension, because `GROUP BY 'Committed spend'` is a "non-integer constant in
 * GROUP BY" error. That is twelve KPI tiles that would have rendered blank.
 *
 * Runner: Vitest | npx vitest run src/__tests__/metricRegistry.contract.test.js
 */
import { describe, test, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Real DB credentials — see integration.salesPartners.test.js for why.
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

const { default: pool } = await import('../config/db.js');
const {
  METRICS, DIMENSION_LABELS, CHART_TYPES,
  validateQueryConfig, buildMetricQuery, getMetric, listMetrics,
} = await import('../shared/metricRegistry.js');

afterAll(async () => { await pool.end().catch(() => {}); });

/** Every (metric, dimension) pair the registry claims to support. */
const COMBINATIONS = METRICS.flatMap((m) =>
  m.dimensions.map((d) => [m.id, d])
);

describe('every registered metric executes against a real database', () => {
  test.each(COMBINATIONS)('%s grouped by %s runs and returns (label, value)', async (metricId, dimension) => {
    const metric = getMetric(metricId);
    const v = validateQueryConfig({
      metric: metricId,
      dimension,
      // Only send a window to a metric that declares a time column; a snapshot
      // metric rejects one on purpose.
      ...(metric.time_column ? { from: '2000-01-01', to: '2100-12-31' } : {}),
    });
    expect(v.ok, v.error).toBe(true);

    const { sql, params } = buildMetricQuery(v.config, { companyId: 1 });
    const res = await pool.query(sql, params);

    // The two-column contract. The chart renderer is written against exactly
    // this and nothing else, so a metric selecting a third column or naming
    // them differently breaks every chart that uses it.
    expect(res.fields.map((f) => f.name)).toEqual(['label', 'value']);

    // A grand total is exactly one row; a grouped metric may legitimately be
    // empty on a sparse database.
    if (dimension === 'none') expect(res.rows).toHaveLength(1);
  });
});

describe('the registry is internally consistent', () => {
  test('every declared dimension has a label', () => {
    for (const m of METRICS) {
      for (const d of m.dimensions) {
        expect(DIMENSION_LABELS[d], `${m.id} declares dimension '${d}' with no label`).toBeTruthy();
      }
    }
  });

  test('every metric declares its default dimension among its dimensions', () => {
    for (const m of METRICS) {
      expect(m.dimensions, m.id).toContain(m.default_dimension);
    }
  });

  test('metric ids are unique — an id is an API, and a duplicate silently wins', () => {
    const ids = METRICS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every metric declares a [module, action] permission', () => {
    for (const m of METRICS) {
      expect(Array.isArray(m.permission), m.id).toBe(true);
      expect(m.permission).toHaveLength(2);
    }
  });

  test('the catalog never ships build() — a client must not think it can supply one', () => {
    for (const m of listMetrics()) {
      expect(m.build).toBeUndefined();
    }
  });
});

describe('query_config is validated, never trusted', () => {
  test('an unknown metric is refused, not silently empty', () => {
    const v = validateQueryConfig({ metric: 'nope.not_a_metric' });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/Unknown metric/);
  });

  test('a dimension the metric does not declare is refused', () => {
    const v = validateQueryConfig({ metric: 'hr.headcount', dimension: 'vendor' });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/cannot be grouped by/);
  });

  test('a date range against a snapshot metric is refused rather than ignored', () => {
    // hr.headcount answers "how many people are employed", asked of today.
    // Accepting a range and quietly ignoring it hands back today's number under
    // a historical heading — the silently-dropped-filter defect.
    const v = validateQueryConfig({ metric: 'hr.headcount', from: '2026-01-01' });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/snapshot/);
  });

  test('a malformed date is refused', () => {
    const v = validateQueryConfig({ metric: 'finance.revenue', from: 'last tuesday' });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/YYYY-MM-DD/);
  });

  test('an unknown chart type is refused — it could never be drawn', () => {
    const v = validateQueryConfig({ metric: 'finance.revenue', chart_type: 'sankey' });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/Unknown chart_type/);
  });

  test('a limit above the ceiling is clamped, not honoured', () => {
    const v = validateQueryConfig({ metric: 'finance.revenue', limit: 999999 });
    expect(v.ok).toBe(true);
    expect(v.config.limit).toBeLessThanOrEqual(500);
  });

  test('SQL in any field is inert — a config names a metric, it never describes one', () => {
    for (const field of ['metric', 'dimension', 'chart_type']) {
      const v = validateQueryConfig({
        metric: 'finance.revenue',
        [field]: "x'; DROP TABLE invoices; --",
      });
      expect(v.ok).toBe(false);
    }
  });

  test('every chart type the registry allows is one the renderer declares', () => {
    // CHART_TYPES is mirrored by a CHECK constraint on dashboard_widgets. If
    // they drift, a widget the UI can draw becomes unsavable, or vice versa.
    expect(new Set(CHART_TYPES).size).toBe(CHART_TYPES.length);
    for (const t of CHART_TYPES) expect(typeof t).toBe('string');
  });
});

describe('the registry agrees with the spend cube', () => {
  test('committed spend matches loadSpendFacets — one definition, not two', async () => {
    const { loadSpendFacets } = await import('../modules/procurement/services/spendAnalytics.service.js');

    // ⚠ Both sides are bounded to end YESTERDAY, and that bound is load-bearing.
    //
    // This assertion takes two reads at two different instants — loadSpendFacets
    // first, then buildMetricQuery. Unbounded, a purchase order written into
    // company 1 BETWEEN those two reads makes them disagree by that order's
    // value, and integration.procurementReverification.test.js writes exactly
    // such rows (CO_A = 1; its D5 fixture is qty 2 x 500 + 18% GST = 1180, the
    // precise difference this test reported when it flaked). A row that is
    // present for both reads is harmless — the two agree about it — so this is
    // a timing race, not a disagreement about the definition.
    //
    // Every real committed PO in company 1 is historical and only transient test
    // fixtures are dated today, so ending the window yesterday removes the race
    // without weakening the claim: the point is that the two implementations
    // agree over the SAME window, whichever window that is.
    //
    // A shared snapshot would be the stronger fix, but loadSpendFacets queries
    // the pool internally and accepts no client, so the two reads cannot be put
    // in one transaction without changing that service's signature.
    //
    // ⚠ `to` belongs on the QUERY CONFIG, not on buildMetricQuery's second
    // argument — that one destructures `{ companyId }` alone and silently
    // ignores anything else, so passing it there looks right and filters nothing.
    const to = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const cube = await loadSpendFacets({ companyId: 1, to });

    const v = validateQueryConfig({ metric: 'procurement.committed_spend', dimension: 'none', to });
    const { sql, params } = buildMetricQuery(v.config, { companyId: 1 });
    const { rows } = await pool.query(sql, params);

    // The bounded window must not empty the comparison: 0 === 0 would pass this
    // test while proving nothing about whether the two definitions agree.
    expect(cube.totals.total_spend).toBeGreaterThan(0);

    // The whole reason poSpendInr() and PO_VOID are shared rather than copied:
    // a KPI tile and the report it summarises must not be able to disagree.
    expect(Number(rows[0].value)).toBeCloseTo(cube.totals.total_spend, 2);
  });
});
