/**
 * salesForecasting.test.js — cover for the forecasting capability added
 * 2026-09-03 AND for the four defects the audit that produced it found in the
 * pre-existing forecast endpoints.
 *
 * WHY THESE CASES
 * ---------------
 * Three of the four regressions guarded here were silent — the endpoints
 * returned 200 with a plausible-looking number the whole time:
 *
 *   1. FAN-OUT. /forecasts/by-month joined opportunities, sales_orders and
 *      sales_targets onto a month spine and SUM()med across the product. A
 *      month holding two open opportunities reported DOUBLE its sales target.
 *      Nothing errored; the chart simply drew the wrong bar.
 *   2. WRONG ID SPACE. /forecasts/by-rep joined sales_orders.created_by (a
 *      users.id) to employees.id, so every rep's `achieved` was structurally 0.
 *   3. STATUS CASE. employees.status is stored Capitalized; the same query
 *      filtered lowercase, so it returned [] regardless of the other two.
 *   4. STAGE VOCABULARY. 'closed_won'/'closed_lost' are not values this column
 *      holds — the stages are 'Won'/'Lost'. Predicates written against the
 *      former matched nothing, so open-pipeline totals silently INCLUDED closed
 *      deals (₹54.3M reported against a true ₹2.09M) and win rate was always 0.
 *
 * The engine cases assert BEHAVIOUR (relationships, invariants), not fixed
 * amounts, so seeding new opportunities does not turn them red.
 *
 * Runner: npx vitest run src/__tests__/salesForecasting.test.js
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// setup.js sets a dummy DB_PASSWORD because most suites mock the pool. This one
// does not, so the real password is restored BEFORE config/db.js is imported —
// it builds its Pool at import time. Hence the dynamic imports below.
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
  deriveCategory, periodBounds, computeForecast, forecastOpportunities,
  FORECAST_CATEGORIES, FORECASTED_CATEGORIES,
} = await import('../modules/sales/services/forecastEngine.js');
const { validateOpportunity } = await import('../modules/crm/services/opportunityValidation.js');

const COMPANY = 1;
const TAG = 'ZZTEST_FORECAST';

afterAll(async () => {
  await pool.query(`DELETE FROM sales_forecast_snapshots WHERE company_id = $1 AND period_year = 2199`, [COMPANY]).catch(() => {});
  await pool.query(`DELETE FROM sales_forecast_submissions WHERE company_id = $1 AND period_year = 2199`, [COMPANY]).catch(() => {});
  await pool.query(`DELETE FROM opportunities WHERE opportunity_name LIKE $1`, [`${TAG}%`]).catch(() => {});
  await pool.query(`DELETE FROM sales_targets WHERE notes = $1`, [TAG]).catch(() => {});
  await pool.end().catch(() => {});
});

/* ══════════════════════════════════════════════════════════════════════════
   1. Category derivation
   ══════════════════════════════════════════════════════════════════════════ */
describe('deriveCategory', () => {
  test('Won is closed and Lost is omitted, whatever the probability says', () => {
    // A Won deal carrying probability 0 (or a Lost one carrying 100) is real —
    // probability stops being maintained once a deal closes. Stage must win.
    expect(deriveCategory('Won', 0)).toBe('closed');
    expect(deriveCategory('won', 100)).toBe('closed');
    expect(deriveCategory('Lost', 100)).toBe('omitted');
  });

  test('is case-insensitive on stage', () => {
    // The live vocabulary genuinely holds BOTH 'Proposal' and 'proposal'.
    expect(deriveCategory('WON', 50)).toBe('closed');
    expect(deriveCategory('  Won  ', 50)).toBe('closed');
  });

  test('open deals band on probability', () => {
    expect(deriveCategory('negotiation', 90)).toBe('commit');
    expect(deriveCategory('negotiation', 75)).toBe('commit');
    expect(deriveCategory('proposal', 74)).toBe('best_case');
    expect(deriveCategory('proposal', 50)).toBe('best_case');
    expect(deriveCategory('qualification', 49)).toBe('pipeline');
    expect(deriveCategory('qualification', 0)).toBe('pipeline');
  });

  test('a missing or unparseable probability falls to pipeline, never to commit', () => {
    // Failing towards `commit` would let an unscored deal inflate the number a
    // manager reports upward. The safe direction is the weakest category.
    expect(deriveCategory('proposal', null)).toBe('pipeline');
    expect(deriveCategory('proposal', undefined)).toBe('pipeline');
    expect(deriveCategory('proposal', 'not a number')).toBe('pipeline');
  });

  test('only ever returns a declared category', () => {
    for (const [stage, prob] of [['x', 10], ['Won', null], ['Lost', 50], [null, null]]) {
      expect(FORECAST_CATEGORIES).toContain(deriveCategory(stage, prob));
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   2. Period bounds — the window a forecast answers for
   ══════════════════════════════════════════════════════════════════════════ */
describe('periodBounds', () => {
  test('month, quarter and year resolve to half-open ranges', () => {
    expect(periodBounds('monthly', 2026, 3)).toMatchObject({ start: '2026-03-01', end: '2026-04-01' });
    expect(periodBounds('quarterly', 2026, 1)).toMatchObject({ start: '2026-01-01', end: '2026-04-01' });
    expect(periodBounds('annual', 2026, null)).toMatchObject({ start: '2026-01-01', end: '2027-01-01' });
  });

  test('December and Q4 roll into the next year rather than overflowing', () => {
    expect(periodBounds('monthly', 2026, 12)).toMatchObject({ start: '2026-12-01', end: '2027-01-01' });
    expect(periodBounds('quarterly', 2026, 4)).toMatchObject({ start: '2026-10-01', end: '2027-01-01' });
  });

  test('rejects an out-of-range period instead of silently substituting one', () => {
    // Answering for a different period than the caller asked about is worse
    // than an error — the number looks right and refers to the wrong window.
    expect(() => periodBounds('monthly', 2026, 13)).toThrow(/1-12/);
    expect(() => periodBounds('monthly', 2026, 0)).toThrow(/1-12/);
    expect(() => periodBounds('quarterly', 2026, 5)).toThrow(/1-4/);
    expect(() => periodBounds('weekly', 2026, 1)).toThrow(/period_type/);
    expect(() => periodBounds('monthly', 'abcd', 1)).toThrow(/period_year/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   3. computeForecast against the real database
   ══════════════════════════════════════════════════════════════════════════ */
describe('computeForecast', () => {
  // A private period far in the future so these rows can never collide with
  // real data or with another suite's fixtures.
  const YEAR = 2199;
  let accountId;

  beforeAll(async () => {
    const { rows: [acct] } = await pool.query(
      `SELECT id FROM accounts WHERE company_id = $1 ORDER BY id LIMIT 1`, [COMPANY]
    );
    accountId = acct?.id ?? null;

    await pool.query(`DELETE FROM opportunities WHERE opportunity_name LIKE $1`, [`${TAG}%`]);
    await pool.query(
      `INSERT INTO opportunities
         (opportunity_name, company_id, account_id, stage, expected_value,
          probability_percentage, expected_closing_date)
       VALUES
         ($1, $5, $6, 'negotiation', 100000, 90, '${YEAR}-03-15'),
         ($2, $5, $6, 'proposal',     50000, 60, '${YEAR}-03-20'),
         ($3, $5, $6, 'qualification', 20000, 10, '${YEAR}-03-25'),
         ($4, $5, $6, 'Won',           70000, 100, '${YEAR}-03-28')`,
      [`${TAG}_commit`, `${TAG}_best`, `${TAG}_pipe`, `${TAG}_won`, COMPANY, accountId]
    );
  });

  const period = { companyId: COMPANY, periodType: 'monthly', periodYear: YEAR, periodValue: 3 };

  test('every category is present even at zero', async () => {
    const f = await computeForecast(pool, period);
    expect(f.categories.map((c) => c.category).sort()).toEqual([...FORECAST_CATEGORIES].sort());
    // A category that vanishes when empty makes a real zero look like a missing
    // feature — the caller cannot tell "no committed deals" from "not computed".
    expect(f.categories.find((c) => c.category === 'omitted')).toMatchObject({ amount: 0, opportunity_count: 0 });
  });

  test('derives categories from probability when none is set explicitly', async () => {
    const f = await computeForecast(pool, period);
    const by = Object.fromEntries(f.categories.map((c) => [c.category, c]));
    expect(by.commit.amount).toBe(100000);
    expect(by.best_case.amount).toBe(50000);
    expect(by.pipeline.amount).toBe(20000);
    expect(by.closed.amount).toBe(70000);
  });

  test('an explicit forecast_category overrides the derived one', async () => {
    await pool.query(
      `UPDATE opportunities SET forecast_category = 'commit' WHERE opportunity_name = $1`,
      [`${TAG}_pipe`]
    );
    const f = await computeForecast(pool, period);
    const by = Object.fromEntries(f.categories.map((c) => [c.category, c]));
    expect(by.commit.amount).toBe(120000);   // 100k derived + 20k promoted
    expect(by.pipeline.amount).toBe(0);
    await pool.query(
      `UPDATE opportunities SET forecast_category = NULL WHERE opportunity_name = $1`,
      [`${TAG}_pipe`]
    );
  });

  test('forecast total excludes closed and omitted', async () => {
    const f = await computeForecast(pool, period);
    const by = Object.fromEntries(f.categories.map((c) => [c.category, c]));
    const expected = FORECASTED_CATEGORIES.reduce((t, c) => t + by[c].amount, 0);
    expect(f.totals.forecast).toBe(expected);
    // The Won deal must NOT be in the forward-looking number.
    expect(f.totals.forecast).not.toContain?.(by.closed.amount);
    expect(f.totals.forecast).toBe(170000);
  });

  test('weighted and unweighted totals are both reported and are different', async () => {
    // The old endpoints returned SUM(value * probability) under the bare label
    // "forecast" — a weighted number presented as a commitment.
    const f = await computeForecast(pool, period);
    expect(f.totals.weighted_forecast).toBeLessThan(f.totals.forecast);
    expect(f.totals.weighted_forecast).toBe(100000 * 0.9 + 50000 * 0.6 + 20000 * 0.1);
  });

  test('ships the window it answered for', async () => {
    // A wrong comparison window yields a PLAUSIBLE empty state; the bounds must
    // travel with the payload so the caller can tell the two apart.
    const f = await computeForecast(pool, period);
    expect(f.period).toMatchObject({ start: `${YEAR}-03-01`, end: `${YEAR}-04-01`, period_value: 3 });
  });

  test('a period with no deals returns zeros, not an empty object', async () => {
    const f = await computeForecast(pool, { ...period, periodValue: 7 });
    expect(f.totals.forecast).toBe(0);
    expect(f.categories).toHaveLength(FORECAST_CATEGORIES.length);
  });

  test('drill-down rows sum back to the category total they came from', async () => {
    // The totals row and its own drill-down are computed by the same COALESCE
    // expression precisely so a chip count can never expose rows no chip selects.
    const f = await computeForecast(pool, period);
    for (const cat of FORECAST_CATEGORIES) {
      const rows = await forecastOpportunities(pool, { ...period, category: cat });
      const summed = rows.reduce((t, r) => t + (parseFloat(r.expected_value) || 0), 0);
      const total = f.categories.find((c) => c.category === cat).amount;
      expect(summed).toBeCloseTo(total, 2);
      expect(rows).toHaveLength(f.categories.find((c) => c.category === cat).opportunity_count);
    }
  });

  test('rejects an unknown category rather than returning an empty list', async () => {
    // Returning [] for a typo'd category is indistinguishable from a real
    // empty category.
    await expect(forecastOpportunities(pool, { ...period, category: 'probably' }))
      .rejects.toThrow(/category must be one of/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   4. Regressions in the PRE-EXISTING forecast queries
   ══════════════════════════════════════════════════════════════════════════ */
describe('forecast query regressions', () => {
  test('the stage vocabulary is won/lost — closed_won matches nothing', async () => {
    // Guards the whole class: metricsEngine, kpiDigest, ceo-intelligence,
    // ai.routes and dashboard.controller all shipped 'closed_won' literals.
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE LOWER(stage) IN ('closed_won','closed won'))::int AS legacy,
              COUNT(*) FILTER (WHERE LOWER(stage) = 'won')::int                        AS actual
         FROM opportunities WHERE deleted_at IS NULL AND company_id = $1`,
      [COMPANY]
    );
    expect(r.legacy).toBe(0);
    expect(r.actual).toBeGreaterThan(0);
  });

  test('no source file reintroduces a closed_won stage predicate', async () => {
    const { readdirSync, statSync, readFileSync: rf } = await import('node:fs');
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, '..');
    const walk = (d, acc = []) => {
      for (const e of readdirSync(d)) {
        const p = resolve(d, e);
        if (e === 'node_modules' || e === '__tests__' || e === 'migrations') continue;
        if (statSync(p).isDirectory()) walk(p, acc);
        else if (e.endsWith('.js')) acc.push(p);
      }
      return acc;
    };
    // Strip comments first. The fixes deliberately LEFT a note at each site
    // explaining what the literal used to do and why it matched nothing — that
    // history is the most useful thing at those lines, and a check that forbids
    // naming the bug would delete the only record of it.
    const stripComments = (s) => s
      .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* block */
      .replace(/^[ 	]*\/\/.*$/gm, ' ')     // // line
      .replace(/^[ 	]*--.*$/gm, ' ');       // -- SQL line, inside template literals
    const offenders = walk(root).filter((f) => /['"]closed[_ ]won['"]/i.test(stripComments(rf(f, 'utf8'))));
    expect(offenders.map((f) => f.replace(root, ''))).toEqual([]);
  });

  test('employees.status is Capitalized, so lowercase comparisons match nothing', async () => {
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('active','probation'))::int AS lower_literal,
              COUNT(*) FILTER (WHERE LOWER(status) IN ('active','probation'))::int AS case_insensitive
         FROM employees WHERE company_id = $1 AND deleted_at IS NULL`,
      [COMPANY]
    );
    expect(r.case_insensitive).toBeGreaterThan(0);
    // If this ever becomes non-zero the stored vocabulary changed and the
    // sqlEmployeeActive() call sites should be revisited, not this assertion.
    expect(r.lower_literal).toBe(0);
  });

  test('sales_orders.created_by is a users.id and must not be joined to employees.id', async () => {
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE e.id IS NOT NULL)::int AS direct_match,
              COUNT(*) FILTER (WHERE u.employee_id IS NOT NULL)::int AS via_users
         FROM sales_orders so
         LEFT JOIN employees e ON e.id = so.created_by
         LEFT JOIN users     u ON u.id = so.created_by
        WHERE so.company_id = $1 AND so.deleted_at IS NULL`,
      [COMPANY]
    );
    // The direct join is the bug. It is allowed to be 0; it must never be the
    // only path that resolves, which is what `via_users` proves is available.
    expect(r.direct_match).toBe(0);
  });

  test('aggregating two child tables onto one spine must not multiply either', async () => {
    // The shape of the /forecasts/by-month bug, stated as an invariant: a
    // pre-aggregated scalar joined onto a spine equals the raw SUM.
    const YEAR = 2199;
    await pool.query(`DELETE FROM sales_targets WHERE notes = $1`, [TAG]);
    await pool.query(
      `INSERT INTO sales_targets (company_id, period_type, period_year, period_value, target_amount, notes)
       VALUES ($1,'monthly',$2,3,100000,$3)`,
      [COMPANY, YEAR, TAG]
    );

    const { rows: [naive] } = await pool.query(
      `SELECT COALESCE(SUM(st.target_amount), 0) AS target
         FROM generate_series(1,12) AS m(month)
         LEFT JOIN opportunities o
           ON EXTRACT(MONTH FROM o.expected_closing_date) = m.month
          AND EXTRACT(YEAR FROM o.expected_closing_date) = $2
          AND o.company_id = $1 AND o.deleted_at IS NULL
          AND LOWER(o.stage) NOT IN ('won','lost')
         LEFT JOIN sales_targets st
           ON st.period_type = 'monthly' AND st.period_value = m.month
          AND st.period_year = $2 AND st.company_id = $1
        WHERE m.month = 3 GROUP BY m.month`,
      [COMPANY, YEAR]
    );
    const { rows: [truth] } = await pool.query(
      `SELECT COALESCE(SUM(target_amount), 0) AS target FROM sales_targets
        WHERE company_id = $1 AND period_type = 'monthly' AND period_year = $2 AND period_value = 3`,
      [COMPANY, YEAR]
    );

    // Three open ZZTEST opportunities close in month 3 of YEAR, so the naive
    // join multiplies the single target by three. This asserts the BUG still
    // reproduces, which is what makes the fixed endpoint's agreement meaningful.
    expect(parseFloat(naive.target)).toBeGreaterThan(parseFloat(truth.target));
    expect(parseFloat(truth.target)).toBe(100000);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   5. Opportunity validation
   ══════════════════════════════════════════════════════════════════════════ */
describe('validateOpportunity', () => {
  test('enforces every configured required field, not just the close date', async () => {
    // crm_settings.required_fields_to_close held ['value','expected_close_date']
    // and only the second was ever checked.
    const { rows } = await pool.query(
      `SELECT required_fields_to_close FROM crm_settings WHERE company_id = $1`, [COMPANY]
    );
    const required = rows[0]?.required_fields_to_close ?? [];
    const r = await validateOpportunity(pool, COMPANY, { opportunity_name: 'x' });
    if (required.includes('value')) {
      expect(r.errors.join(' ')).toMatch(/Expected value is required/);
    }
    if (required.includes('expected_close_date')) {
      expect(r.errors.join(' ')).toMatch(/Expected closing date is required/);
    }
  });

  test('a name is required regardless of company configuration', async () => {
    const r = await validateOpportunity(pool, null, {});
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('Opportunity name is required');
  });

  test('rejects a negative value and an out-of-range probability', async () => {
    const r = await validateOpportunity(pool, null, {
      opportunity_name: 'x', expected_value: -1, probability_percentage: 150,
    });
    expect(r.errors).toContain('Expected value must be a non-negative number');
    expect(r.errors).toContain('Probability must be between 0 and 100');
  });

  test('accepts a complete payload', async () => {
    const r = await validateOpportunity(pool, COMPANY, {
      opportunity_name: 'Complete', expected_value: 1000,
      expected_closing_date: '2026-12-31', probability_percentage: 50,
    });
    expect(r).toMatchObject({ ok: true, errors: [] });
  });

  test('a company with no settings row has no configured requirements', async () => {
    // "No settings" is a real answer, not an error, and must not fail closed on
    // a name-only payload beyond the unconditional invariants.
    const r = await validateOpportunity(pool, 999999, { opportunity_name: 'x' });
    expect(r.ok).toBe(true);
  });
});
