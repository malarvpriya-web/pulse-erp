import { isNullishText } from './nullish.js';

/**
 * employeeHierarchy — one validator for "may this person report to that person?".
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * `employees.reporting_manager_id` is a self-referencing FK with `ON DELETE SET
 * NULL` and nothing else: no CHECK against self-reference, and no way for a
 * relational constraint to express "no cycles". The validation that did exist
 * was `orgChartRepository.wouldCreateCycle`, reachable from two of the four
 * write paths:
 *
 *   PUT /orgchart/hierarchy      (bulk)    → checked
 *   POST/PUT /orgchart (upsert)            → checked
 *   PUT /orgchart/reporting-manager (single) → NOT checked   ← the split-path gap
 *   POST/PUT /employees (Add/Edit Employee)  → NOT checked   ← the All Employees path
 *
 * Live result: employee 1 (`Malar Natesh`, designation **CEO**) had
 * `reporting_manager_id = 1` — their own manager. A recursive walk of the org
 * chart from employees 2 and 3 therefore terminated only because
 * `wouldCreateCycle`'s `visited` set caught it; the raw `WITH RECURSIVE` in
 * `GET /employees/direct-reports` and in the analytics org queries has no such
 * guard and relies on a depth cap.
 *
 * ── Why a shared module rather than reusing wouldCreateCycle ─────────────────
 * That one queries the `pool` directly, so it cannot participate in the caller's
 * transaction — the check and the write are not atomic, and two concurrent
 * assignments can each pass and together form a loop. This takes a `db` handle,
 * so a caller inside a transaction gets a check against the same snapshot it is
 * about to write into. It also enforces the tenant boundary, which
 * `wouldCreateCycle` does not look at at all.
 */

function badRequest(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * Depth ceiling for the upward walk.
 *
 * The walk already terminates on a repeat via `seen`, so this is not the cycle
 * guard — it is a guard against a pathological chain (or a corrupted one) making
 * a single save issue hundreds of queries. 60 is far beyond any real
 * organisation's depth.
 */
const MAX_DEPTH = 60;

/**
 * Throws a 400 unless `managerId` may manage `employeeId`.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} db  pool, or a client inside a transaction
 * @param {object}  opts
 * @param {number|null} opts.employeeId  null for an employee that does not exist yet
 * @param {number|null} opts.managerId   null / undefined clears the manager, always allowed
 * @param {number|null} opts.companyId   tenant scope; null = unscoped (global caller)
 * @param {string} [opts.label]          how to name the employee in an error message
 */
export async function assertValidManager(db, { employeeId, managerId, companyId = null, label } = {}) {
  // `isNullishText`, not just `== null`: a multipart form serialises a null
  // value to the STRING "null", which is neither nullish nor empty and which
  // Number() turns into NaN — so an untouched Reporting Manager picker read as
  // a malformed id and 400'd the entire save with
  //   "null" is not a valid reporting manager
  // See shared/nullish.js. This is the very column that already holds the
  // literal text 'null' on three live rows, which is how it got there.
  if (managerId == null || managerId === '' || isNullishText(managerId)) return null;

  const mgrId = Number(managerId);
  if (!Number.isInteger(mgrId) || mgrId < 1) {
    throw badRequest(`"${managerId}" is not a valid reporting manager.`);
  }

  const empId = employeeId == null ? null : Number(employeeId);
  const who = label || (empId != null ? `Employee #${empId}` : 'This employee');

  // 1. Self-reference. Checked before any query: it is the one case that needs
  // none, and it is the case that was actually in the data.
  if (empId != null && mgrId === empId) {
    throw badRequest(
      `${who} cannot be their own reporting manager. Leave the manager empty for the top of the hierarchy.`,
    );
  }

  // 2. The manager must exist, be live, and be in the same company. A manager in
  // another tenant is a cross-tenant edge: it would make one company's org chart
  // walk into another's, and `GET /employees/direct-reports` joins on this column
  // with no company predicate of its own on the manager side.
  const { rows: [mgr] } = await db.query(
    `SELECT id, company_id, deleted_at,
            COALESCE(NULLIF(TRIM(name), ''), TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''))) AS name
       FROM employees WHERE id = $1`,
    [mgrId],
  );
  if (!mgr || mgr.deleted_at != null) {
    throw badRequest(`Reporting manager #${mgrId} does not exist.`, 404);
  }
  if (companyId != null && mgr.company_id !== companyId) {
    // Deliberately the same wording as "does not exist": telling a caller that
    // an id is real but belongs to someone else is itself a cross-tenant leak.
    throw badRequest(`Reporting manager #${mgrId} does not exist.`, 404);
  }

  // 3. Walk UP from the proposed manager. Reaching `employeeId` means the new
  // edge closes a loop: A → B → … → A.
  if (empId != null) {
    const chain = [mgrId];
    const seen = new Set([mgrId]);
    let cursor = mgrId;

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const { rows: [row] } = await db.query(
        `SELECT reporting_manager_id AS mgr FROM employees WHERE id = $1`,
        [cursor],
      );
      const next = row?.mgr ?? null;
      if (next == null) return mgr;                    // reached the top, no loop

      if (next === empId) {
        throw badRequest(
          `That would create a circular reporting chain: ` +
          `${who} → ${chain.join(' → ')} → ${who}.`,
        );
      }
      if (seen.has(next)) {
        // A pre-existing loop further up, not one this edge creates. Refuse
        // anyway — hanging a new report off a corrupted chain makes the
        // corruption load-bearing, and say where it is so it can be fixed.
        throw badRequest(
          `The proposed manager already sits in a circular reporting chain ` +
          `(employee #${next}). Fix that chain before assigning reports into it.`,
        );
      }
      seen.add(next);
      chain.push(next);
      cursor = next;
    }

    throw badRequest(
      `The reporting chain above employee #${mgrId} is more than ${MAX_DEPTH} levels deep — refusing to extend it.`,
    );
  }

  return mgr;
}

/**
 * Every hierarchy defect currently in the table, for the data-quality report and
 * the contract test. Read-only.
 *
 * The cycle query excludes the self-loop from its seed so that a self-managing
 * employee is reported once, as a self-loop, rather than also appearing as a
 * "cycle" in every subordinate's path — which is what the first pass over this
 * data did: employee 1's self-loop showed up as cycles rooted at 2 and 3.
 */
export async function findHierarchyDefects(db, companyId = null) {
  const scope = `($1::int IS NULL OR e.company_id = $1)`;

  const { rows: selfManaged } = await db.query(
    `SELECT e.id, e.office_id, e.company_id, e.designation,
            COALESCE(NULLIF(TRIM(e.name),''), TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,''))) AS name
       FROM employees e
      WHERE e.reporting_manager_id = e.id AND ${scope}
      ORDER BY e.id`,
    [companyId],
  );

  const { rows: crossTenant } = await db.query(
    `SELECT e.id, e.company_id AS employee_company, m.id AS manager_id, m.company_id AS manager_company
       FROM employees e JOIN employees m ON m.id = e.reporting_manager_id
      WHERE COALESCE(e.company_id, 0) <> COALESCE(m.company_id, 0) AND ${scope}
      ORDER BY e.id`,
    [companyId],
  );

  const { rows: cycles } = await db.query(
    `WITH RECURSIVE walk(root, node, depth, path, looped) AS (
       SELECT e.id, e.reporting_manager_id, 1, ARRAY[e.id], false
         FROM employees e
        WHERE e.reporting_manager_id IS NOT NULL
          AND e.reporting_manager_id <> e.id
          AND ${scope}
       UNION ALL
       SELECT w.root, m.reporting_manager_id, w.depth + 1, w.path || m.id, m.id = ANY(w.path)
         FROM walk w JOIN employees m ON m.id = w.node
        WHERE NOT w.looped AND w.depth < 60
          AND m.reporting_manager_id IS NOT NULL
          AND m.reporting_manager_id <> m.id
     )
     SELECT DISTINCT root, path FROM walk WHERE looped ORDER BY root`,
    [companyId],
  );

  const { rows: [orphanNames] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM employees e
      WHERE NULLIF(TRIM(e.reporting_manager), '') IS NOT NULL
        AND LOWER(TRIM(e.reporting_manager)) NOT IN ('null', 'undefined')
        AND e.reporting_manager_id IS NULL
        AND ${scope}`,
    [companyId],
  );

  return { selfManaged, crossTenant, cycles, managerNameWithoutId: orphanNames.n };
}

export default { assertValidManager, findHierarchyDefects };
