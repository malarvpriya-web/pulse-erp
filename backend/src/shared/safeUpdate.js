/**
 * safeUpdate.js — guard for the generic "build a SET clause from an object" idiom.
 *
 * Several repositories implement update() as:
 *
 *   Object.keys(data).forEach(key => {
 *     fields.push(`${key} = $${n++}`);   // <- key is interpolated, NOT bound
 *     values.push(data[key]);
 *   });
 *
 * and their routes call `repo.update(req.params.id, req.body)`. The VALUES are
 * parameterised, but the KEYS are not: they reach the statement verbatim. That
 * gives any caller who can hit the endpoint two things:
 *
 *   1. Mass assignment — set columns the form never offered (company_id,
 *      created_by, deleted_at), escaping tenant scoping or silently soft-deleting.
 *   2. SQL injection via the key — an assignment list is a SQL fragment, so a
 *      crafted key injects further assignments into the same UPDATE.
 *
 * pickUpdatable() closes both by validating every key against the table's REAL
 * columns (read from information_schema, cached per process) minus a protected
 * set. Deriving the allowlist from the live schema rather than a hand-written
 * column list matters here: these tables are wide and drift (see the audit docs),
 * and a hand-maintained list silently drops legitimate fields the moment a
 * migration adds one — turning a security fix into a data-loss bug.
 *
 * Identity, ownership, tenancy and audit columns are never writable through a
 * generic update. A caller that legitimately needs to move one (e.g. a transfer)
 * must do it in an explicit, purpose-built statement.
 */

import pool from '../config/db.js';

const columnCache = new Map();

/** Live column set for a table, cached for the life of the process. */
async function columnsOf(table) {
  if (columnCache.has(table)) return columnCache.get(table);
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  const cols = new Set(rows.map(r => r.column_name));
  // Don't cache a miss: an empty set would permanently blank every update to a
  // table this ran against before its migration landed.
  if (cols.size) columnCache.set(table, cols);
  return cols;
}

/**
 * Never writable through a generic update, even though they are real columns.
 * `id` is the WHERE target; the rest are tenancy/ownership/audit facts that must
 * be set by the server, not by whoever shaped the request body.
 */
const PROTECTED = new Set([
  'id', 'company_id', 'branch_id',
  'created_at', 'created_by', 'updated_at', 'deleted_at',
]);

/**
 * Reduce a caller-supplied object to the keys that may safely become a SET clause.
 *
 * @param {string} table            physical table name
 * @param {object} data             caller-supplied payload (often req.body)
 * @param {object} [opts]
 * @param {string[]} [opts.protect] extra columns to refuse, on top of PROTECTED
 * @param {string[]} [opts.allow]   columns to permit despite being PROTECTED —
 *                                  use only for server-computed values the route
 *                                  itself supplies, never for raw request data
 * @returns {Promise<object>}       a new object holding only the safe keys
 */
export async function pickUpdatable(table, data, opts = {}) {
  const cols = await columnsOf(table);
  const protect = new Set([...PROTECTED, ...(opts.protect ?? [])]);
  for (const a of opts.allow ?? []) protect.delete(a);

  const safe = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === undefined) continue;
    if (!cols.has(key)) continue;      // not a real column -> cannot be injected
    if (protect.has(key)) continue;    // real, but not writable this way
    safe[key] = value;
  }
  return safe;
}

/** Test seam — drops the cached schema so a migration mid-process is picked up. */
export function _resetColumnCache() {
  columnCache.clear();
}
