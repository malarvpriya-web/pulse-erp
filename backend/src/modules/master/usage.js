// ──────────────────────────────────────────────────────────────────────────────
// usage.js — "what would I break?" for a master-data value.
//
// WHY THIS EXISTS
// ---------------
// Master Data Setup could rename and retire values with no idea what used them.
// Renaming a department rewrites the vocabulary on every employee row, report
// filter and job opening that carries it, and the screen offering that button
// showed a bare list of names. This answers the question the button needs
// answered first.
//
// ⚠ THESE MASTERS ARE REFERENCED BY NAME, NOT BY FOREIGN KEY.
// `employees.department` is a VARCHAR holding the text 'Engineering', not an FK
// to `master_departments(id)`. Verified against information_schema, not assumed.
// Three consequences, and they shape every rule below:
//
//   1. Deleting a master row CANNOT orphan a record or violate a constraint.
//      The employee keeps the string. So the delete guard here is about intent
//      and hygiene, not referential integrity — it stops someone silently
//      removing a value 8 people are filed under, it is not preventing a crash.
//   2. Deactivating is genuinely lossless: the value stops being OFFERED, every
//      historical row still reads back exactly as before, and MasterSelect
//      renders a stored-but-unlisted value as its own option so View/Edit
//      Employee still shows it.
//   3. A hard-deleted department that employees still carry would come BACK in
//      the picker as an `unmanaged` row, because GET /master/:type unions the
//      master with the distinct values on employees. Hard delete is therefore
//      only honest when nothing references the value — which is exactly the
//      rule below.
//
// WHY A CURATED LIST AND NOT EVERY MATCHING COLUMN
// ------------------------------------------------
// 32 tables carry a column literally named `department`. Counting all of them
// would be a 32-way UNION per row and would report `warehouses` and
// `routing_steps` to an HR administrator deciding whether to retire
// "Facilities". The lists below are the references a human actually weighs,
// each one checked to exist. Anything not listed is still safe, because the
// DEFAULT action is deactivation, which preserves everything.
// ──────────────────────────────────────────────────────────────────────────────
import pool from '../../config/db.js';
import { BY_KEY } from './vocabularies.js';

/**
 * master key → the references worth reporting.
 *
 * `table`  the table to count in
 * `column` the TEXT column holding the master's name
 * `label`  what the count is called on screen ("8 employees")
 *
 * Every table here was verified to exist and to carry `company_id`; the two
 * that do not (`reimbursement_claims`, `rfq_quotes`) are deliberately absent
 * rather than counted unscoped, because an unscoped count would leak one
 * tenant's volume to another.
 */
export const USAGE = {
  departments: [
    { table: 'employees',         column: 'department', label: 'employee' },
    { table: 'users',             column: 'department', label: 'user account' },
    { table: 'job_requisitions',  column: 'department', label: 'requisition' },
    { table: 'job_openings',      column: 'department', label: 'job opening' },
    { table: 'purchase_requests', column: 'department', label: 'purchase request' },
    { table: 'budgets',           column: 'department', label: 'budget' },
    { table: 'cost_centers',      column: 'department', label: 'cost centre' },
    { table: 'interns',           column: 'department', label: 'intern' },
  ],
  designations: [
    { table: 'employees',       column: 'designation', label: 'employee' },
    { table: 'job_offers',      column: 'designation', label: 'job offer' },
    { table: 'contract_labour', column: 'designation', label: 'contract worker' },
    { table: 'interns',         column: 'designation', label: 'intern' },
  ],
  zones: [
    { table: 'employees',        column: 'zone', label: 'employee' },
    { table: 'projects',         column: 'zone', label: 'project' },
    { table: 'leads',            column: 'zone', label: 'lead' },
    { table: 'support_tickets',  column: 'zone', label: 'ticket' },
    { table: 'service_engineers', column: 'zone', label: 'service engineer' },
  ],
  grades: [
    { table: 'employees',           column: 'grade', label: 'employee' },
    { table: 'travel_policy_rules', column: 'grade', label: 'travel policy rule' },
  ],
  bands: [
    { table: 'employees', column: 'band', label: 'employee' },
  ],
};

/**
 * A vocabulary's references, derived from the `columns` it already declares in
 * vocabularies.js.
 *
 * Not a second list. That registry field exists precisely so "the audit report
 * and the seeding migration are generated from the same list the API serves,
 * rather than from a second copy that rots" — this is a third consumer of it,
 * which is the point.
 */
export function usageForVocab(key) {
  const entry = BY_KEY[key];
  if (!entry) return [];
  const byName = (entry.columns || []).map(pair => {
    const [table, column] = pair.split('.');
    return { table, column, label: singular(table) };
  });
  // An FK to master_values(id) rather than a copy of the name. Counted by
  // resolving the id back to its value, so callers still key results by name
  // and nothing upstream changes. `type` pins the lookup to this vocabulary —
  // 'Production' or 'Service' may exist in another one.
  const byId = (entry.idColumns || []).map(pair => {
    const [table, column] = pair.split('.');
    return { table, column, label: singular(table), byId: true, type: entry.type };
  });
  return [...byName, ...byId];
}

/**
 * The lower-cased master value a reference holds, as SQL over the row's own
 * columns. A name reference is the column itself; an id reference is the
 * master_values value it points at. Unqualified on purpose: the scope and
 * soft-delete predicates appended after it are unqualified too, and must bind
 * to the referencing table, not to master_values.
 */
const valueExpr = (r) => (r.byId
  ? `(SELECT LOWER(BTRIM(mv.value)) FROM master_values mv
       WHERE mv.id = ${r.column} AND mv.type = '${r.type}')`
  : `LOWER(BTRIM(COALESCE(${r.column}, '')))`);

/** `job_requisitions` → `job requisition`. Only for a fallback label. */
const singular = (table) =>
  table.replace(/_/g, ' ').replace(/ies$/, 'y').replace(/s$/, '');

/**
 * How a table with NO company_id of its own reaches one.
 *
 * The scope clause below is `cols.has('<table>.company_id') ? ... : ''` — i.e. a
 * table without that column is counted UNSCOPED, which is why this file's header
 * says `reimbursement_claims` and `rfq_quotes` are "deliberately absent rather
 * than counted unscoped, because an unscoped count would leak one tenant's
 * volume to another".
 *
 * `bgv_checks` is the first declared reference in that position, and leaving it
 * out was not an option either: the whole point of counting BGV check types is
 * so Master Data can say "6 checks use this" before someone retires the value.
 * So instead of a third choice between a leak and a blind spot, a table may
 * declare the path to its tenant. The predicate must reference `$2` (the
 * caller's company) and nothing else, because that is the only other binding in
 * scope at the call sites below.
 */
const SCOPE_VIA = {
  bgv_checks: `case_id IN (SELECT c.id FROM bgv_cases c
                             JOIN employees e ON e.id = c.employee_id AND e.deleted_at IS NULL
                            WHERE e.company_id = $2)`,
};

/**
 * The tenant predicate for one reference, or '' when there is none to apply.
 *
 * ⚠ A table with neither its own company_id nor a SCOPE_VIA entry still returns
 * '' — i.e. it is counted across every tenant, exactly as before this helper
 * existed. `rfq_quotes.payment_terms` and `reimbursement_claims.claim_type` are
 * in that position today. That is a pre-existing gap, left alone here on
 * purpose: narrowing those two counts is a change to what the payment-terms and
 * expense-type masters report, which belongs in its own pass with its own test,
 * not smuggled into the BGV work. This helper exists so `bgv_checks` does not
 * JOIN that list.
 */
function scopeFor(ref, cols, isGlobal) {
  if (isGlobal) return '';
  if (cols.has(`${ref.table}.company_id`)) return ` AND ($2::int IS NULL OR company_id = $2)`;
  if (SCOPE_VIA[ref.table])               return ` AND ($2::int IS NULL OR ${SCOPE_VIA[ref.table]})`;
  return '';
}

/**
 * The bindings for a usage statement.
 *
 * ⚠ `$2` is bound ONLY when some part of the statement references it. Postgres
 * rejects a bound-but-unreferenced parameter outright — "bind message supplies 2
 * parameters, but prepared statement requires 1" — and that is exactly what
 * happened for a GLOBAL (super-admin) scope, where scopeFor() returns '' for
 * every reference and no `$2` survives into the SQL. So the usage counts threw
 * for a super-admin on every vocabulary, and the same would happen for any
 * vocabulary whose only reference is a table with neither company_id nor a
 * SCOPE_VIA entry. [[project_pg_unreferenced_param_bind_error]]
 *
 * Found by a BGV test asserting that a global scope counts across tenants; the
 * fault itself predates that work.
 */
const bindingsFor = (sql, needle, companyId) =>
  sql.includes('$2') ? [needle, companyId ?? null] : [needle];

/**
 * Which of a declared reference list actually exist in THIS database.
 *
 * Cached for the process. A reference to a table or column that is not there
 * must not 500 the usage endpoint: these declarations span modules that a
 * given deployment may not have migrated yet, and "I could not count this" is
 * not a reason to refuse to answer the rest.
 */
let schemaCache = null;
async function knownColumns() {
  if (schemaCache) return schemaCache;
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'`);
  schemaCache = new Set(rows.map(r => `${r.table_name}.${r.column_name}`));
  return schemaCache;
}

/** Test seam — the schema does not change under a running process, but a suite
 *  that creates a table mid-run needs to say so. */
export function __resetUsageSchemaCache() { schemaCache = null; }

/**
 * Count, per reference, how many rows carry `value`, scoped to one company.
 *
 * Matching is `LOWER(BTRIM(...))` on both sides, the same normalisation the
 * duplicate guard uses. An exact-match count would report 0 for a department
 * stored as 'engineering ' and invite a delete that strands it.
 *
 * @param {Array}  refs      from USAGE[...] or usageForVocab()
 * @param {string} value     the master value's name
 * @param {number|null} companyId
 * @param {boolean} isGlobal  a global scope counts across all tenants
 * @param {object=} db        a PoolClient to run on instead of the shared pool.
 *   Route handlers never pass it. A TEST does: its fixtures live in an open
 *   transaction that is rolled back afterwards, and the shared pool cannot see
 *   uncommitted rows — so without this seam the only way to test a usage count
 *   is to commit fixture rows into the live register, which is exactly what a
 *   test must not do. Same seam `assertValidBranch(client, ...)` uses.
 * @returns {Promise<{total:number, breakdown:Array<{label,count}>}>}
 */
export async function countUsage(refs, value, companyId, isGlobal = false, db = pool) {
  const needle = String(value ?? '').trim().toLowerCase();
  if (!needle || !refs.length) return { total: 0, breakdown: [] };

  const cols = await knownColumns();
  const usable = refs.filter(r => cols.has(`${r.table}.${r.column}`));
  if (!usable.length) return { total: 0, breakdown: [] };

  // One statement, not one per reference: this runs on every row of a master
  // list, and a 7-reference department master would otherwise be 7 round trips
  // per row.
  const parts = usable.map((r, i) => {
    const scope = scopeFor(r, cols, isGlobal);
    const soft = cols.has(`${r.table}.deleted_at`) ? ` AND deleted_at IS NULL` : '';
    return `SELECT ${i} AS ix, COUNT(*)::int AS n FROM ${r.table}
             WHERE ${valueExpr(r)} = $1${scope}${soft}`;
  });

  const sql = parts.join(' UNION ALL ');
  const { rows } = await db.query(sql, bindingsFor(sql, needle, companyId));
  const breakdown = [];
  let total = 0;
  for (const row of rows) {
    const ref = usable[row.ix];
    if (row.n > 0) {
      total += row.n;
      breakdown.push({ label: ref.label, count: row.n, table: ref.table });
    }
  }
  breakdown.sort((a, b) => b.count - a.count);
  return { total, breakdown };
}

/**
 * Usage for a whole list in one pass, keyed by lower-cased value.
 *
 * Master Data Setup draws a count beside every row, so the per-row version
 * would be N × M round trips for a 24-row designation master.
 */
export async function countUsageBulk(refs, values, companyId, isGlobal = false, db = pool) {
  const out = {};
  const cols = await knownColumns();
  const usable = refs.filter(r => cols.has(`${r.table}.${r.column}`));
  const names = values.map(v => String(v ?? '').trim().toLowerCase()).filter(Boolean);
  for (const n of names) out[n] = { total: 0, breakdown: [] };
  if (!usable.length || !names.length) return out;

  const parts = usable.map((r, i) => {
    const scope = scopeFor(r, cols, isGlobal);
    const soft = cols.has(`${r.table}.deleted_at`) ? ` AND deleted_at IS NULL` : '';
    return `SELECT ${i} AS ix, ${valueExpr(r)} AS v, COUNT(*)::int AS n
              FROM ${r.table}
             WHERE ${valueExpr(r)} = ANY($1::text[])${scope}${soft}
             GROUP BY 2`;
  });

  const sql = parts.join(' UNION ALL ');
  const { rows } = await db.query(sql, bindingsFor(sql, names, companyId));
  for (const row of rows) {
    const bucket = out[row.v];
    if (!bucket) continue;
    bucket.total += row.n;
    bucket.breakdown.push({ label: usable[row.ix].label, count: row.n, table: usable[row.ix].table });
  }
  for (const k of Object.keys(out)) out[k].breakdown.sort((a, b) => b.count - a.count);
  return out;
}

/**
 * Render a breakdown as the sentence the confirm dialog shows.
 *   [{label:'employee',count:8},{label:'requisition',count:3}] → "8 employees, 3 requisitions"
 */
export const describeUsage = (breakdown) =>
  breakdown.map(b => `${b.count} ${b.label}${b.count === 1 ? '' : 's'}`).join(', ');

export default USAGE;
