// backend/src/shared/analyticsQuery.js
//
// A query runner for the Analytics & AI surface that keeps "no rows matched"
// and "this statement failed" as different answers.
//
// WHY THIS EXISTS
// ---------------
// Every analytics handler used to wrap its queries in `.catch(() => [])` (78
// call sites). A rejected statement therefore reached the user as an empty
// array or a zero, inside an HTTP 200, indistinguishable from a genuinely
// empty result. Nineteen statements were failing on every single request when
// this was written — the CFO Dashboard rendered "No cash flow data for this
// period" over Rs 64 lakh of paid invoices, and /ai/chat answered "No overdue
// invoices found" with fifteen invoices past due.
//
// The fix is not to remove the fallback — a dashboard with nine panels should
// still render eight when one query breaks. The fix is to make the failure
// travel with the response so the UI can say "this panel is unavailable"
// instead of "this panel is empty", and so a test can assert the difference.
//
// USAGE
// -----
//   import { analyticsQuery } from '../../shared/analyticsQuery.js';
//
//   const q = analyticsQuery('cfo-dashboard');
//   const [rev, exp] = await Promise.all([
//     q.rows('SELECT …', params, 'monthly_revenue'),
//     q.rows('SELECT …', params, 'monthly_expense'),
//   ]);
//   res.json({ ...payload, ...q.report() });
//
// `q.report()` is `{}` when everything succeeded, so a healthy response is
// byte-identical to what it was before. When something failed it adds:
//
//   { dataUnavailable: ['monthly_revenue'], degraded: true }
//
// RULES
// -----
//   * Every call MUST pass a stable `key`. It names the panel in the response
//     and in the log line; an anonymous failure is only marginally better than
//     a swallowed one.
//   * Never widen a catch to make this quiet. If a key shows up in
//     `dataUnavailable`, the SQL is wrong — fix the SQL.
//   * `scripts/audit/sql-failure-probe.mjs` catches these at the driver level
//     regardless of what the handler does, and exits non-zero. Keep it in CI.

import pool from '../config/db.js';

/**
 * @param {string} scope  label for the log line, e.g. 'cfo-dashboard'
 */
export function analyticsQuery(scope = 'analytics') {
  /** @type {string[]} keys whose query rejected */
  const failed = [];

  const record = (key, err) => {
    if (!failed.includes(key)) failed.push(key);
    // One line per distinct failure, carrying the SQLSTATE so a grep of the
    // logs is enough to classify it (42703 missing column, 42601 syntax, …).
    console.error(`[${scope}] query "${key}" failed [${err.code || 'n/a'}]: ${err.message}`);
  };

  return {
    /** Rows, or [] with the failure recorded. Drop-in for `.catch(() => [])`. */
    async rows(sql, params = [], key = 'unnamed') {
      try {
        return (await pool.query(sql, params)).rows;
      } catch (err) {
        record(key, err);
        return [];
      }
    },

    /**
     * First row, or `fallback` with the failure recorded.
     * Pass the shape the caller destructures so it does not need a null guard.
     */
    async one(sql, params = [], key = 'unnamed', fallback = null) {
      try {
        return (await pool.query(sql, params)).rows[0] ?? fallback;
      } catch (err) {
        record(key, err);
        return fallback;
      }
    },

    /** True when at least one query rejected. */
    get degraded() {
      return failed.length > 0;
    },

    /** The keys that failed, for a caller that wants to branch on a specific one. */
    get unavailable() {
      return [...failed];
    },

    /**
     * Spread into the response body. Empty object on a clean run, so a healthy
     * payload keeps exactly the shape it had before this wrapper existed.
     */
    report() {
      return failed.length ? { dataUnavailable: [...failed], degraded: true } : {};
    },
  };
}

export default analyticsQuery;
