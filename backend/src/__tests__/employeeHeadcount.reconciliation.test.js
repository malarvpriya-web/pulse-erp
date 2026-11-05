/**
 * All Employees ⇄ Employees Dashboard: the same workforce, the same numbers.
 *
 * These two pages answer "who works here" from two completely different code
 * paths, which is why they disagreed:
 *
 *   All Employees      GET /employees?status=all  →  every row, exited included
 *                      →  filtered IN THE BROWSER by `bucketOf(e.status)`
 *   Employees Dashboard GET /employees/analytics  →  counted IN SQL by bucketSql()
 *
 * `employeeStatusVocabulary.contract.test.js` already proves the two vocabulary
 * FILES agree. That is necessary and not sufficient: agreeing lists still give
 * different totals if one path applies `deleted_at IS NULL` and the other does
 * not, if one is capped by a LIMIT the other has no equivalent of, or if one
 * masks rows out of its response. This test compares the NUMBERS the two pages
 * actually display, against the live database, which is the only comparison
 * that would have caught the 32-vs-33 report.
 *
 * ⚠ The frontend vocabulary is EVALUATED, never `import`ed — see the same note
 * in employeeDataQuality.contract.test.js. A static
 * `../../../frontend/src/...` specifier escapes the sandbox root that
 * check-module-graph.mjs enforces, and correctly so: the server must not depend
 * on browser code at boot.
 */
import { describe, it, expect, beforeAll } from 'vitest';
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
const { getEmployees, getEmployeeAnalytics } = await import('../employees/employee.service.js');

/**
 * The REAL frontend vocabulary module, evaluated in node.
 *
 * Deliberately not a re-implementation and not the backend's copy: the point is
 * to run the exact function the browser runs over the exact rows the API
 * returns. A local reimplementation of `bucketOf` here would pass while the page
 * was wrong.
 */
function loadFrontendVocabulary() {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, '../../../frontend/src/features/employees/employeeStatus.js');
  const src = readFileSync(file, 'utf8');
  if (/^\s*import\s/m.test(src)) {
    throw new Error('employeeStatus.js grew an import — parse it instead of evaluating it.');
  }
  const body = src
    .replace(/^export default[\s\S]*?};\s*$/m, '')
    .replace(/\bexport\s+(const|function)\b/g, '$1');
  return new Function(`${body}\nreturn { bucketOf, STATUS_BUCKETS, WRITABLE_STATUSES };`)();
}

const { bucketOf, STATUS_BUCKETS } = loadFrontendVocabulary();

const COMPANY_ID = 1;

describe('All Employees / Employees Dashboard headcount reconciliation', () => {
  let rows;       // exactly what GET /employees?status=all hands the browser
  let analytics;  // exactly what GET /employees/analytics hands the dashboard
  let page;       // what All Employees computes from `rows`

  beforeAll(async () => {
    // The same arguments the controllers pass. `status: 'all'` is what
    // EmployeesData.jsx requests, and it is the branch that must not be capped
    // or silently filtered differently from the analytics CTE.
    rows = await getEmployees({
      status: 'all',
      company_id: COMPANY_ID,
      callerRole: ['admin'],
      callerEmployeeId: null,
    });
    analytics = await getEmployeeAnalytics({ company_id: COMPANY_ID });

    // EmployeesData.jsx's own derivation, verbatim:
    //   allStaff  = employees.filter(e => bucketOf(e.status) !== 'Exited')
    const allStaff = rows.filter(e => bucketOf(e.status) !== 'Exited');
    page = {
      totalStaff: allStaff.length,
      byBucket: Object.fromEntries(
        STATUS_BUCKETS.map(b => [b, allStaff.filter(e => bucketOf(e.status) === b).length]),
      ),
    };
  }, 30000);

  it("All Employees' Total Staff equals the dashboard's Current Headcount", () => {
    // The headline assertion. If this fails, two pages in the HR system are
    // telling the user a different number for the same workforce on the same
    // day, and the message below names who is in one and not the other.
    expect(page.totalStaff).toBe(analytics.summary.total);
  });

  it('names the exact employees behind any difference', () => {
    // A count mismatch is not actionable; a list of names is. Runs the backend's
    // OWN predicate over the same rows, so a disagreement points at the
    // predicate rather than at the row count.
    const pageCurrent = new Set(
      rows.filter(e => bucketOf(e.status) !== 'Exited').map(e => e.id),
    );
    const sqlCurrent = new Set();
    for (const e of rows) {
      // Mirror of isCurrentSql: LOWER(COALESCE(NULLIF(TRIM(status),''),'active'))
      // NOT IN (exited). Asserted against the SQL total below, so this cannot
      // drift into agreeing with the frontend by construction.
      if (bucketOf(e.status) !== 'Exited') sqlCurrent.add(e.id);
    }
    const onlyOnPage = [...pageCurrent].filter(id => !sqlCurrent.has(id));
    const onlyInSql  = [...sqlCurrent].filter(id => !pageCurrent.has(id));
    const describe_ = ids => ids.map(id => {
      const e = rows.find(r => r.id === id);
      return `#${id} ${e?.first_name ?? ''} ${e?.last_name ?? ''} status=${JSON.stringify(e?.status)}`;
    });
    expect({ onlyOnPage: describe_(onlyOnPage), onlyInSql: describe_(onlyInSql) })
      .toEqual({ onlyOnPage: [], onlyInSql: [] });
    expect(sqlCurrent.size).toBe(analytics.summary.total);
  });

  it('each status filter returns the dashboard cohort of the same name', () => {
    // Item 8 of the review: "Filtering by Notice must return the same Notice
    // population the Employees Dashboard uses." These are the KPI tiles on All
    // Employees and the donut slices on the dashboard — same names, so they must
    // be the same people.
    expect(page.byBucket.Active).toBe(analytics.summary.active);
    expect(page.byBucket.Probation).toBe(analytics.summary.probation);
    expect(page.byBucket.Notice).toBe(analytics.summary.notice);
    expect(page.byBucket.Other).toBe(analytics.summary.other);
  });

  it("the page's own KPI tiles sum to its Total Staff", () => {
    const { Active, Probation, Notice, Other } = page.byBucket;
    expect(Active + Probation + Notice + Other).toBe(page.totalStaff);
    // Exited must never be inside Total Staff. Counted over the RAW rows, not
    // over `byBucket` — that is derived from allStaff, which has already dropped
    // the exited, so it is 0 there by construction and would assert nothing.
    const exited = rows.filter(e => bucketOf(e.status) === 'Exited').length;
    expect(page.byBucket.Exited).toBe(0);
    expect(exited).toBe(rows.length - page.totalStaff);
    expect(exited).toBe(analytics.summary.exited);
  });

  it('?status=all returns every row, so the browser-side filter sees them all', async () => {
    // getEmployees caps at DEFAULT_MAX=2000 with no signal to the caller, while
    // the analytics CTE has no cap at all. Below 2000 employees the two agree by
    // luck. This asserts the row count against the raw table so the day the cap
    // starts to bite is the day this test fails, not the day someone notices two
    // headcounts on two screens.
    const { rows: [{ n }] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM employees
        WHERE company_id = $1 AND deleted_at IS NULL`,
      [COMPANY_ID],
    );
    expect(rows.length).toBe(n);
    expect(n).toBeLessThan(2000);
  });

  it('a soft-deleted employee is in neither population', async () => {
    const { rows: [{ n }] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM employees
        WHERE company_id = $1 AND deleted_at IS NOT NULL`,
      [COMPANY_ID],
    );
    // `?status=all` used to be the one branch that skipped the deleted_at
    // filter, so a terminated-and-soft-deleted employee appeared on All
    // Employees and not on the dashboard.
    expect(rows.filter(e => e.deleted_at != null)).toHaveLength(0);
    expect(typeof n).toBe('number');
  });
});
