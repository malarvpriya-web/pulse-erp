/**
 * Dashboard filter helpers — canonical parsing of the date-range and dimension
 * filters that every dashboard endpoint accepts.
 *
 * Before this existed, dashboard endpoints hardcoded their own windows
 * (`date_trunc('month', NOW())`, `INTERVAL '90 days'`, …) and accepted no query
 * params, so the UI had nothing to filter against. Endpoints should now call
 * `resolveRange(req.query)` and bind the returned bounds as normal `$n`
 * parameters — never interpolate dates into SQL text.
 *
 * Contract with the frontend (`hooks/useDashboardFilters.js`):
 *   ?period=mtd|qtd|ytd|fytd|last7|last30|last90|last12m|all|custom
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   (required when period=custom)
 *
 * Indian FY (Apr 1 – Mar 31) is the basis for `fytd`, matching FYContext on the
 * frontend and the existing fyStart/fyEnd params in finance.routes.js.
 *
 * @example
 *   const { from, to, isAll } = resolveRange(req.query);
 *   const p = [companyOf(req), from, to];
 *   pool.query(
 *     `SELECT COUNT(*) FROM ncr_reports
 *       WHERE ($1::int IS NULL OR company_id = $1)
 *         AND ($2::date IS NULL OR created_at >= $2::date)
 *         AND ($3::date IS NULL OR created_at < ($3::date + INTERVAL '1 day'))`, p);
 *
 * `to` is INCLUSIVE of the whole day — always compare with
 * `< ($n::date + INTERVAL '1 day')` on timestamp columns so rows stamped later
 * in the day are not silently dropped.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const PERIOD_PRESETS = [
  'mtd', 'qtd', 'ytd', 'fytd', 'last7', 'last30', 'last90', 'last6m', 'last12m', 'all', 'custom',
];

/** Default preset when the caller sends nothing. */
export const DEFAULT_PERIOD = 'fytd';

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Start of the Indian financial year containing `d` (Apr 1). */
function fyStartOf(d) {
  const calYear = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return new Date(calYear, 3, 1);
}

function daysAgo(d, n) {
  const c = new Date(d);
  c.setDate(c.getDate() - n);
  return c;
}

/**
 * Resolve a query object into concrete inclusive date bounds.
 *
 * @param {object} [query] typically `req.query`
 * @param {string} [query.period] one of PERIOD_PRESETS
 * @param {string} [query.from] YYYY-MM-DD (used when period=custom)
 * @param {string} [query.to] YYYY-MM-DD (used when period=custom)
 * @param {object} [opts]
 * @param {string} [opts.defaultPeriod=DEFAULT_PERIOD] preset to use when the
 *   caller sends no `period` — pass 'all' for endpoints whose numbers are
 *   point-in-time balances rather than period activity.
 * @param {Date}   [opts.now] injectable clock, for tests.
 * @returns {{period:string, from:string|null, to:string|null, isAll:boolean, label:string}}
 *   `from`/`to` are null when the range is unbounded (period=all), which the
 *   `$n::date IS NULL OR …` predicate turns into "no filter".
 */
export function resolveRange(query = {}, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const requested = String(query.period || '').trim().toLowerCase();
  const fallback = opts.defaultPeriod || DEFAULT_PERIOD;
  let period = PERIOD_PRESETS.includes(requested) ? requested : fallback;

  const from = ISO_DATE.test(String(query.from || '')) ? String(query.from) : null;
  const to = ISO_DATE.test(String(query.to || '')) ? String(query.to) : null;

  // An explicit from/to pair is honoured even without period=custom, so callers
  // that already send start_date/end_date style params keep working.
  if (period === 'custom' && !from && !to) period = fallback;
  if (from || to) {
    // Guard inverted ranges rather than returning an always-empty result set.
    const lo = from && to && from > to ? to : from;
    const hi = from && to && from > to ? from : to;
    return { period: 'custom', from: lo, to: hi, isAll: false, label: rangeLabel(lo, hi) };
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endStr = iso(today);

  switch (period) {
    case 'all':
      return { period, from: null, to: null, isAll: true, label: 'All time' };
    case 'mtd':
      return mk(period, new Date(today.getFullYear(), today.getMonth(), 1), endStr, 'This month');
    case 'qtd': {
      const qStartMonth = Math.floor(today.getMonth() / 3) * 3;
      return mk(period, new Date(today.getFullYear(), qStartMonth, 1), endStr, 'This quarter');
    }
    case 'ytd':
      return mk(period, new Date(today.getFullYear(), 0, 1), endStr, 'Calendar YTD');
    case 'last7':
      return mk(period, daysAgo(today, 6), endStr, 'Last 7 days');
    case 'last30':
      return mk(period, daysAgo(today, 29), endStr, 'Last 30 days');
    case 'last90':
      return mk(period, daysAgo(today, 89), endStr, 'Last 90 days');
    case 'last6m': {
      const s = new Date(today);
      s.setMonth(s.getMonth() - 6);
      return mk(period, s, endStr, 'Last 6 months');
    }
    case 'last12m': {
      const s = new Date(today);
      s.setMonth(s.getMonth() - 12);
      return mk(period, s, endStr, 'Last 12 months');
    }
    case 'fytd':
    default:
      return mk('fytd', fyStartOf(today), endStr, 'This financial year');
  }
}

function mk(period, startDate, endStr, label) {
  return { period, from: iso(startDate), to: endStr, isAll: false, label };
}

function rangeLabel(from, to) {
  if (from && to) return `${from} to ${to}`;
  if (from) return `From ${from}`;
  if (to) return `Up to ${to}`;
  return 'All time';
}

/**
 * Read an optional scalar dimension filter (department, status, project…).
 * Returns null for absent / blank / the sentinel "all", which the standard
 * `($n IS NULL OR col = $n)` predicate treats as unfiltered.
 *
 * @param {object} query `req.query`
 * @param {string} key   param name
 * @param {string[]} [allowed] if given, values outside the list resolve to null
 *   — use this for anything that reaches SQL as an identifier or enum.
 */
export function dimension(query = {}, key, allowed = null) {
  const raw = query?.[key];
  if (raw == null) return null;
  const v = String(raw).trim();
  if (v === '' || v.toLowerCase() === 'all') return null;
  if (allowed && !allowed.includes(v)) return null;
  return v;
}

/** Same as `dimension` but coerced to an integer id (null when not numeric). */
export function idDimension(query = {}, key) {
  const v = dimension(query, key);
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

export default { resolveRange, dimension, idDimension, PERIOD_PRESETS, DEFAULT_PERIOD };

/**
 * FY_START_SQL — the Indian financial year boundary, as a SQL expression.
 *
 * Three copies of this existed (metricsEngine.js, ceo-intelligence.routes.js and,
 * by omission, dashboard.controller.js which used the calendar year instead).
 * That omission is how /dashboard/summary came to report Rs 62.9 lakh "revenue
 * YTD" against a canonical Rs 2.4 lakh: a different year boundary, a different
 * date column, and no status filter, all under the same label.
 *
 * Anything answering "year to date" for a money figure MUST use this. Pair it
 * with `isIn('status', INVOICE_PAID)` and `COALESCE(invoice_date, created_at)`.
 */
export const FY_START_SQL = `make_date(
  CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= 4
       THEN EXTRACT(YEAR FROM CURRENT_DATE)::int
       ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int - 1 END, 4, 1)`;

/** Same boundary as a JS Date, for handlers that bind it as a parameter. */
export function fyStartDate(now = new Date()) {
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return new Date(Date.UTC(y, 3, 1));
}

/**
 * assertDateParams — reject a malformed `from`/`to` with 400 instead of 500.
 *
 * `resolveRange` silently ignores an unparseable date and falls back to the
 * default period, but several export endpoints interpolate `req.query.from`
 * straight into SQL. `?from=xx` therefore reached Postgres and came back as
 * "invalid input syntax for type timestamp with time zone" inside a 500 — the
 * same bad input produced three different behaviours across the module (a clean
 * 400 on /dashboard/cfo, a silent default on the shared-vocabulary endpoints,
 * and a 500 on the six employee-report exports).
 *
 * Call it first in any handler that reads from/to directly.
 *
 * @returns {null|{status:number, body:object}} null when the input is fine.
 */
const ISO_DATE_STRICT = /^\d{4}-\d{2}-\d{2}$/;
export function assertDateParams(query = {}, keys = ['from', 'to']) {
  const bad = [];
  for (const k of keys) {
    const v = query[k];
    if (v === undefined || v === null || v === '') continue;
    const s = String(v);
    if (!ISO_DATE_STRICT.test(s) || Number.isNaN(Date.parse(s))) bad.push({ param: k, value: s });
  }
  if (!bad.length) return null;
  return {
    status: 400,
    body: {
      error: `Invalid date parameter${bad.length > 1 ? 's' : ''}: ${bad.map(b => `${b.param}="${b.value}"`).join(', ')}.`,
      expected: 'YYYY-MM-DD',
      invalid: bad,
    },
  };
}
