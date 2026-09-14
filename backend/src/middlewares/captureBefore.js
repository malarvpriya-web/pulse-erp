/**
 * captureBefore.js — the before-image, captured structurally.
 *
 * WHY
 * ---
 * §157 put the audit floor on 158 route mounts, so no mutation is invisible.
 * But the floor only sees the REQUEST and the RESPONSE: it records what was
 * attempted, not what the value changed FROM. For finance and payroll that is
 * usually the question being asked — "this cost centre now says ₹4,00,000; what
 * did it say yesterday, and who changed it?"
 *
 * An explicit `logAudit({ oldData })` answers that, and 133 call sites do it.
 * Hand-adding a SELECT to the ~190 that don't is a large diff that is wrong the
 * moment somebody adds handler 191. This captures it once per route instead.
 *
 * HOW IT REACHES THE LOG
 * ----------------------
 * Stashes the row on `req._auditBefore`. Both writers pick it up:
 *   - `auditMutations` uses it as oldData;
 *   - `logAudit` falls back to it when a handler passes no oldData of its own.
 * So a handler that already logs carefully keeps its own richer snapshot, and
 * one that logs carelessly — or not at all — still gets a before-image.
 *
 * ⚠ TENANT SCOPE IS NOT OPTIONAL HERE. The row goes into the audit log, so
 * fetching it without a company predicate would write another tenant's data
 * into this tenant's audit trail — a leak through the one table nobody thinks
 * to check. The predicate is applied whenever the table has a `company_id`,
 * which is discovered once per table and cached.
 *
 * It never breaks a request: a failure means no before-image, not a 500.
 */

import pool from '../config/db.js';
import { companyOf } from '../shared/scope.js';

const MUTATING = new Set(['PUT', 'PATCH', 'DELETE']);

/**
 * Does this table carry company_id? Resolved once, then cached.
 *
 * `undefined` while in flight, so a burst of concurrent requests does not each
 * fire the same information_schema query.
 */
const hasCompanyCol = new Map();

/**
 * Clear the cache. Tests only — the cache is module-level and deliberately
 * survives requests, so without this one test's table lookup silently satisfies
 * the next one's and the assertion passes for the wrong reason.
 */
export function __resetTableScopeCache() {
  hasCompanyCol.clear();
}

async function tableIsScoped(table) {
  if (hasCompanyCol.has(table)) return hasCompanyCol.get(table);
  const p = pool
    .query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'company_id'
        LIMIT 1`,
      [table]
    )
    .then((r) => r.rowCount > 0)
    .catch(() => false);
  hasCompanyCol.set(table, p);
  return p;
}

/**
 * @param {string} table   table the handler mutates
 * @param {{ param?: string, column?: string }} [opts]
 *        param  — route param holding the key (default 'id')
 *        column — column that param matches (default 'id')
 */
export function captureBefore(table, opts = {}) {
  const param  = opts.param  ?? 'id';
  const column = opts.column ?? 'id';

  // Identifiers are interpolated, so they must be provably safe — they come
  // from call sites in this repo, never from a request, and this keeps it so.
  if (!/^[a-z_][a-z0-9_]*$/i.test(table) || !/^[a-z_][a-z0-9_]*$/i.test(column)) {
    throw new Error(`captureBefore: unsafe identifier ${table}.${column}`);
  }

  return async function captureBeforeMiddleware(req, res, next) {
    if (!MUTATING.has(req.method)) return next();
    const id = req.params?.[param];
    if (id == null || id === '') return next();

    try {
      const scoped = await tableIsScoped(table);
      const companyId = scoped ? companyOf(req) : null;

      // A NULL company_id row is visible to a scoped caller elsewhere in this
      // codebase, so the predicate matches that convention rather than
      // inventing a stricter one only the audit path uses.
      const sql = scoped
        ? `SELECT * FROM ${table} WHERE ${column} = $1
             AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL) LIMIT 1`
        : `SELECT * FROM ${table} WHERE ${column} = $1 LIMIT 1`;

      const { rows } = await pool.query(sql, scoped ? [id, companyId] : [id]);
      if (rows[0]) req._auditBefore = rows[0];
    } catch (err) {
      // No before-image is a worse audit entry; a 500 is a worse product.
      console.warn(JSON.stringify({
        ts: new Date().toISOString(), level: 'WARN', event: 'capture_before_failed',
        table, param, message: err.message, path: req.originalUrl,
      }));
    }
    next();
  };
}

export default captureBefore;
