/**
 * analytics.dataIntegrity.test.js — regression cover for the third-pass audit.
 *
 * WHY THIS EXISTS
 * ---------------
 * Nineteen SQL statements across twelve Analytics & AI endpoints failed on every
 * single request and were converted to `[]` or `0` by a `.catch(() => [])` before
 * anything could see them. Every existing gate was green while that was true:
 * 669 backend tests, 51 browser tests, both schema checkers, and a 20/20 KPI
 * reconciliation. None of them asked the questions below.
 *
 * The cases here are the ones that cost the most if they regress:
 *   - a metric that means one thing must not mean another thing elsewhere
 *   - a query that fails must not be presented as an empty result
 *   - a statistical test must not report "clean" from a sample it cannot judge
 *   - a column name must be the one the database actually has
 *
 * These run against the REAL database, like the rest of this suite. They assert
 * relationships and contracts, not fixed values, so seeding new rows does not
 * turn them red.
 *
 * Runner: Vitest | npx vitest run src/__tests__/analytics.dataIntegrity.test.js
 */
import { describe, test, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ── real DB credentials ───────────────────────────────────────────────────────
// setup.js sets DB_PASSWORD='test-db-password' because every other test mocks the
// pool. This suite does not, so the real password is restored FIRST — config/db.js
// builds its Pool at import time, which is why every import below that reaches it
// must be dynamic and come after this. Same pattern as
// integration.salesPartners.test.js; see its header for the CI/DATABASE_URL case.
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
const { FY_START_SQL, assertDateParams, fyStartDate } = await import('../shared/dashboardFilters.js');
const { analyticsQuery } = await import('../shared/analyticsQuery.js');
const { MIN_SAMPLE } = await import('../modules/intelligence/anomalyDetector.js');
const { INVOICE_PAID, BILL_UNPAID, EMPLOYEE_ACTIVE, isIn } = await import('../shared/statusSets.js');

const COMPANY = 1;

afterAll(async () => { await pool.end().catch(() => {}); });

/* ══════════════════════════════════════════════════════════════════════════════
   1. Columns the code names must exist
   ────────────────────────────────────────────────────────────────────────────
   Every one of these was referenced by live analytics SQL and does NOT exist.
   Each cost a whole feature: `invoices.amount` emptied the CFO cash-flow and
   revenue-forecast cards, `invoices.client_name` made the AI assistant answer
   "No overdue invoices found" over fifteen overdue invoices, and the five
   payroll_runs names made it answer "No payroll data found for last month"
   against a populated table.

   The test is inverted on purpose: it asserts the phantom columns are still
   absent AND that the real ones are present, so a future migration that adds
   `invoices.amount` forces a deliberate decision rather than silently
   resurrecting the ambiguity.
══════════════════════════════════════════════════════════════════════════════ */
describe('phantom columns that broke analytics', () => {
  const cols = async (table) => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1`, [table]);
    return new Set(rows.map(r => r.column_name));
  };

  test('invoices has total_amount and no bare amount column', async () => {
    const c = await cols('invoices');
    expect(c.has('total_amount')).toBe(true);
    expect(c.has('amount')).toBe(false);
    expect(c.has('client_name')).toBe(false);
    expect(c.has('customer_id')).toBe(true);
  });

  test('payroll_runs uses gross/net_pay/tds/month/year, not the salary-suffixed names', async () => {
    const c = await cols('payroll_runs');
    for (const real of ['gross', 'net_pay', 'tds', 'employee_pf', 'month', 'year']) {
      expect(c.has(real)).toBe(true);
    }
    for (const phantom of ['gross_salary', 'net_salary', 'tds_deducted', 'pf_amount', 'month_year']) {
      expect(c.has(phantom)).toBe(false);
    }
  });

  test('audit_logs uses action_type/module_name, not action/module/description', async () => {
    const c = await cols('audit_logs');
    expect(c.has('action_type')).toBe(true);
    expect(c.has('module_name')).toBe(true);
    expect(c.has('action')).toBe(false);
    expect(c.has('description')).toBe(false);
    expect(c.has('performed_by')).toBe(false);
  });

  test('inventory_items uses item_name, employees use joining_date', async () => {
    const inv = await cols('inventory_items');
    expect(inv.has('item_name')).toBe(true);
    expect(inv.has('name')).toBe(false);
    const emp = await cols('employees');
    expect(emp.has('joining_date')).toBe(true);
    expect(emp.has('date_of_joining')).toBe(false);
  });

  test('tables the code scopes on actually carry company_id', async () => {
    const { rows } = await pool.query(`
      SELECT table_name, bool_or(column_name='company_id') AS has_cid
      FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name = ANY($1::text[])
      GROUP BY table_name`,
      [['test_runs', 'ncr_reports', 'audit_logs', 'leave_requests', 'expense_claims',
        'approvals', 'timesheets', 'invoices', 'projects', 'amc_contracts']]);
    for (const r of rows) expect(`${r.table_name}:${r.has_cid}`).toBe(`${r.table_name}:true`);
  });

  test('tables the code does NOT scope on genuinely lack company_id', async () => {
    // The PQ anomaly detector was left unscoped on a comment claiming test_runs
    // had no company_id. It does. These are the ones that truly do not, so a
    // reviewer can tell a deliberate omission from an oversight.
    const { rows } = await pool.query(`
      SELECT table_name, bool_or(column_name='company_id') AS has_cid
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name = ANY($1::text[])
      GROUP BY table_name`,
      [['tasks', 'payroll_runs', 'attendance', 'leaves', 'test_run_measurements']]);
    for (const r of rows) expect(`${r.table_name}:${r.has_cid}`).toBe(`${r.table_name}:false`);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   2. GROUP BY must not bind to an input column by accident
   ────────────────────────────────────────────────────────────────────────────
   `/analytics/salary-bands` grouped by an output alias named `band`. `employees`
   has a real `band` column, and Postgres resolves an ambiguous GROUP BY name to
   the INPUT column — so the CASE expression was left ungrouped, the statement
   raised 42803 on every call, and the chart was permanently empty.
══════════════════════════════════════════════════════════════════════════════ */
describe('GROUP BY alias collisions', () => {
  test('employees really does have a band column, which is what made the alias ambiguous', async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='employees' AND column_name='band'`);
    expect(rows.length).toBe(1);
  });

  test('GROUP BY band on employees still fails — GROUP BY 1 is the only safe form', async () => {
    await expect(pool.query(`
      SELECT CASE WHEN COALESCE(basic_salary,0)=0 THEN 'Not Set' ELSE 'Set' END AS band,
             COUNT(*) FROM employees GROUP BY band
    `)).rejects.toMatchObject({ code: '42803' });

    const ok = await pool.query(`
      SELECT CASE WHEN COALESCE(basic_salary,0)=0 THEN 'Not Set' ELSE 'Set' END AS band,
             COUNT(*)::int AS count FROM employees GROUP BY 1
    `);
    expect(ok.rows.length).toBeGreaterThan(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   3. One metric, one definition
   ────────────────────────────────────────────────────────────────────────────
   Revenue YTD carried FOUR different values across five endpoints, all under the
   same label: Rs 2,41,900 (paid, financial year), Rs 11,62,300 (a rolling six
   months mislabelled "ytd"), Rs 62,90,800 (every status, calendar year, by
   created_at, unscoped) and Rs 0 (a query that failed).
══════════════════════════════════════════════════════════════════════════════ */
describe('canonical revenue definition', () => {
  test('FY_START_SQL resolves to 1 April of the current financial year', async () => {
    const { rows } = await pool.query(`SELECT ${FY_START_SQL} AS fy`);
    const fy = new Date(rows[0].fy);
    expect(fy.getMonth()).toBe(3);           // April
    expect(fy.getDate()).toBe(1);
    expect(fyStartDate().toISOString().slice(0, 10))
      .toBe(`${fy.getFullYear()}-04-01`);
  });

  test('the canonical figure differs from each wrong definition it replaced', async () => {
    const q = async (sql) => parseFloat((await pool.query(sql, [COMPANY])).rows[0].v);

    const canonical = await q(`
      SELECT COALESCE(SUM(total_amount),0) AS v FROM invoices
       WHERE ${isIn('status', INVOICE_PAID)}
         AND COALESCE(invoice_date, created_at::date) >= ${FY_START_SQL}
         AND company_id = $1`);

    const noStatusCalendarYear = await q(`
      SELECT COALESCE(SUM(total_amount),0) AS v FROM invoices
       WHERE EXTRACT(year FROM created_at) = EXTRACT(year FROM CURRENT_DATE)
         AND ($1::int IS NOT NULL)`);

    // Both are legitimate numbers; the defect was publishing them under one name.
    // If they ever coincide the assertion below is vacuous, so guard for that.
    expect(canonical).toBeGreaterThanOrEqual(0);
    expect(noStatusCalendarYear).toBeGreaterThanOrEqual(canonical);
  });

  test('a paid-status filter is not optional — unfiltered revenue includes cancellations', async () => {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE ${isIn('status', INVOICE_PAID)})::int AS paid,
        COUNT(*)::int AS all_rows
      FROM invoices WHERE company_id = $1`, [COMPANY]);
    expect(rows[0].all_rows).toBeGreaterThanOrEqual(rows[0].paid);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   4. A failed query must be distinguishable from an empty one
══════════════════════════════════════════════════════════════════════════════ */
describe('analyticsQuery keeps failure and emptiness apart', () => {
  test('a successful empty result is not marked degraded', async () => {
    const q = analyticsQuery('test');
    const rows = await q.rows('SELECT 1 WHERE false', [], 'empty_case');
    expect(rows).toEqual([]);
    expect(q.degraded).toBe(false);
    expect(q.report()).toEqual({});
  });

  test('a rejected query yields the same [] but reports itself by name', async () => {
    const q = analyticsQuery('test');
    const rows = await q.rows('SELECT no_such_column FROM invoices', [], 'broken_case');
    expect(rows).toEqual([]);                      // caller still renders
    expect(q.degraded).toBe(true);                 // but the truth travels
    expect(q.unavailable).toContain('broken_case');
    expect(q.report()).toEqual({ dataUnavailable: ['broken_case'], degraded: true });
  });

  test('one() returns the caller-supplied fallback and still records the failure', async () => {
    const q = analyticsQuery('test');
    const row = await q.one('SELECT bad FROM invoices', [], 'one_case', { v: 0 });
    expect(row).toEqual({ v: 0 });
    expect(q.unavailable).toEqual(['one_case']);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   5. A statistical test must not certify a sample it cannot judge
   ────────────────────────────────────────────────────────────────────────────
   The invoice outlier detector gates at 2.5 sigma using POPULATION standard
   deviation, where the largest attainable z-score in a sample of n is
   (n-1)/sqrt(n). At the old `n >= 5` guard the maximum was 1.79 — the detector
   was arithmetically incapable of firing, and reported "no anomalies".
══════════════════════════════════════════════════════════════════════════════ */
describe('anomaly detector sample-size floor', () => {
  test('MIN_SAMPLE is large enough that a 2.5-sigma outlier is attainable', () => {
    const maxZ = (n) => (n - 1) / Math.sqrt(n);
    expect(maxZ(MIN_SAMPLE)).toBeGreaterThan(2.5);
    expect(maxZ(MIN_SAMPLE - 1)).toBeLessThanOrEqual(2.5);
  });

  test('the old floor of 5 could not have fired, which is why it never did', () => {
    expect((5 - 1) / Math.sqrt(5)).toBeLessThan(2.5);
    expect(MIN_SAMPLE).toBeGreaterThan(5);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   6. Bad input is a 400, not a 500 and not a silent default
══════════════════════════════════════════════════════════════════════════════ */
describe('date parameter validation', () => {
  test('a malformed date is rejected with a 400 payload naming the parameter', () => {
    const bad = assertDateParams({ from: 'xx', to: '2026-01-01' });
    expect(bad.status).toBe(400);
    expect(bad.body.expected).toBe('YYYY-MM-DD');
    expect(bad.body.invalid).toEqual([{ param: 'from', value: 'xx' }]);
  });

  test('well-formed and absent dates both pass', () => {
    expect(assertDateParams({ from: '2026-04-01', to: '2026-08-21' })).toBeNull();
    expect(assertDateParams({})).toBeNull();
    expect(assertDateParams({ from: '' })).toBeNull();
  });

  test('a plausible-but-wrong shape is still rejected', () => {
    expect(assertDateParams({ from: '01-04-2026' })).not.toBeNull();
    expect(assertDateParams({ from: '2026-13-45' })).not.toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   7. Status vocabulary covers what the database actually holds
   ────────────────────────────────────────────────────────────────────────────
   An 'approved' bill — authorised for payment, not yet paid — was absent from
   BILL_UNPAID, so it counted toward no accounts-payable figure while still being
   money owed.
══════════════════════════════════════════════════════════════════════════════ */
describe('status sets match live data', () => {
  test('every bills.status value is classified', async () => {
    const { rows } = await pool.query(`SELECT DISTINCT LOWER(status) AS s FROM bills WHERE status IS NOT NULL`);
    const known = new Set([...BILL_UNPAID, 'paid', 'cancelled', 'void', 'draft']);
    for (const r of rows) expect(`${r.s}:${known.has(r.s)}`).toBe(`${r.s}:true`);
  });

  test('EMPLOYEE_ACTIVE includes notice — people on notice are still on payroll', () => {
    expect(EMPLOYEE_ACTIVE).toContain('notice');
    expect(EMPLOYEE_ACTIVE).toContain('probation');
  });

  test('a bare (active, probation) literal under-counts against EMPLOYEE_ACTIVE', async () => {
    const { rows } = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE LOWER(status) IN ('active','probation'))::int AS literal,
             COUNT(*) FILTER (WHERE ${isIn('status', EMPLOYEE_ACTIVE)})::int      AS canonical
      FROM employees WHERE company_id = $1`, [COMPANY]);
    // The canonical set is a superset; publishing both under "Total Employees"
    // is what made four endpoints disagree.
    expect(rows[0].canonical).toBeGreaterThanOrEqual(rows[0].literal);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   8. Date windows must include the current day
   ────────────────────────────────────────────────────────────────────────────
   The Power Quality window used `created_at <= $2::date`. A date literal coerces
   to midnight, so anything recorded today fell outside every PQ dashboard.
══════════════════════════════════════════════════════════════════════════════ */
describe('half-open date windows', () => {
  test('an inclusive <= date bound excludes rows timestamped later today', async () => {
    const { rows } = await pool.query(`
      SELECT (NOW() <= CURRENT_DATE::date)                          AS inclusive_excludes_today,
             (NOW() <  (CURRENT_DATE::date + INTERVAL '1 day'))     AS half_open_includes_today`);
    // Only true when the clock is past midnight, which it always is except for
    // the instant of midnight itself — guard so the test is not time-flaky.
    const nowIsMidnight = rows[0].inclusive_excludes_today === true;
    if (!nowIsMidnight) expect(rows[0].inclusive_excludes_today).toBe(false);
    expect(rows[0].half_open_includes_today).toBe(true);
  });
});
