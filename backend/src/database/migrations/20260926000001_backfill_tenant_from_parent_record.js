/**
 * Migration: stamp NULL-company transactional rows with the tenant of their
 * PARENT RECORD.
 *
 * WHY A DIFFERENT APPROACH TO 20260917000005
 * ------------------------------------------
 * That migration inferred the owner from the table itself — "all the stamped
 * rows in travel_requests agree on company 1, so the NULL ones are company 1".
 * That is sound for a table the whole of which belongs to one tenant, and it is
 * the best available answer when a row has no parent to ask.
 *
 * It is NOT the best answer when the row DOES have a parent. A journal line
 * belongs to the company of its journal ENTRY, not to whichever company happens
 * to own most of journal_lines. Deriving from the parent is correct in a
 * genuinely multi-tenant install, where the table-wide inference would refuse to
 * run at all (it skips when the stamped rows disagree). So every table below is
 * backfilled from its own parent row, one UPDATE per table, and a row whose
 * parent is missing or itself unstamped is LEFT ALONE rather than guessed at.
 *
 * WHY IT MATTERS
 * --------------
 * `company_id` is nullable on 375 of the 489 tables that carry it, and the
 * codebase reads it two incompatible ways: `company_id = $1` (1,136 uses) and
 * `... OR company_id IS NULL` (285 uses, 92 files). A NULL-tenant row is
 * therefore invisible to every tenant under the first idiom and visible to all
 * of them under the second — and, because NULL <> NULL in Postgres, it also
 * slips past every composite unique index that leads with company_id. One
 * duplicate lead email already exists in this database that way.
 *
 * MEASURED BEFORE WRITING (2026-09-26), NULL rows / total:
 *   journal_lines 12/30 · production_operations 7/14 · pick_lists 5/6
 *   bom_lines 3/13 · quotations 3/9 · lifecycle_instances 2/19
 *   attendance_records 1/74 · leads 1/22 · travel_requests 1/285
 *   engineering_changes 1/4                                    → 36 rows
 *
 * Of those 36, a dry run resolved 28 from a parent. The 8 that did not are not
 * business data and are deliberately left as they are:
 *   - pick_lists 21-25 are 2026-08-20 empty-table-seeder fixtures whose
 *     sales_order_id values (1-5) point at sales orders that do not exist.
 *   - leads 10, travel_requests 300 and engineering_changes 4 carry a NULL
 *     owner_id / employee_id, so there is no parent to derive from at all.
 * Both groups want deleting, not stamping, and deleting rows is not a
 * migration's decision to make.
 *
 * NOT NULL is deliberately NOT added here. These ten tables are a first pass;
 * the column stays nullable until the same exercise has been done for the rest,
 * or a NOT NULL here just moves the failure to an INSERT that has not been
 * taught to supply it. See §175 in MODULE_FEATURE_CONNECTION_MANUAL.md.
 */

// table -> SQL expression deriving company_id for one NULL row, aliased `t`.
const PLANS = [
  ['journal_lines',
    `(SELECT je.company_id FROM journal_entries je WHERE je.id::text = t.entry_id::text)`],
  ['production_operations',
    `(SELECT po.company_id FROM production_orders po WHERE po.id = t.production_order_id)`],
  ['bom_lines',
    `(SELECT bh.company_id FROM bom_headers bh WHERE bh.id = t.bom_id)`],
  ['quotations',
    `COALESCE((SELECT u.company_id  FROM users u         WHERE u.id = t.created_by),
              (SELECT p.company_id  FROM parties p       WHERE p.id = t.customer_id),
              (SELECT o.company_id  FROM opportunities o WHERE o.id = t.opportunity_id))`],
  ['lifecycle_instances',
    `COALESCE((SELECT po.company_id FROM production_orders po WHERE po.id = t.production_order_id),
              (SELECT so.company_id FROM sales_orders so      WHERE so.id = t.sales_order_id),
              (SELECT pr.company_id FROM projects pr          WHERE pr.id = t.project_id))`],
  ['attendance_records',
    `(SELECT e.company_id FROM employees e WHERE e.id = t.employee_id)`],
  ['pick_lists',
    `(SELECT so.company_id FROM sales_orders so WHERE so.id = t.sales_order_id)`],
  ['leads',
    `COALESCE((SELECT e.company_id  FROM employees e  WHERE e.id = t.owner_id),
              (SELECT e2.company_id FROM employees e2 WHERE e2.id = t.assigned_to))`],
  ['travel_requests',
    `(SELECT e.company_id FROM employees e WHERE e.id = t.employee_id)`],
  ['engineering_changes',
    `(SELECT e.company_id FROM employees e WHERE e.id = t.owner_id)`],
];

export async function up(knex) {
  let stamped = 0, skipped = 0;

  for (const [table, expr] of PLANS) {
    // Does the table still exist with a company_id column? A migration that
    // assumes today's schema breaks every fresh-database build later.
    const { rows: present } = await knex.raw(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'company_id'`,
      [table]
    );
    if (!present.length) {
      console.warn(`[20260926000001] ${table}: no company_id column — skipped.`);
      continue;
    }

    const { rows: before } = await knex.raw(
      `SELECT t.id, ${expr} AS derived FROM "${table}" t WHERE t.company_id IS NULL ORDER BY t.id`
    );
    if (!before.length) {
      console.log(`[20260926000001] ${table}: no NULL company_id rows. Nothing to do.`);
      continue;
    }

    const res = await knex.raw(
      `UPDATE "${table}" t SET company_id = ${expr}
        WHERE t.company_id IS NULL AND ${expr} IS NOT NULL`
    );

    const unresolved = before.filter(r => r.derived == null).map(r => r.id);
    stamped += res.rowCount || 0;
    skipped += unresolved.length;
    console.log(
      `[20260926000001] ${table}: stamped ${res.rowCount || 0} of ${before.length} row(s) from parent`
      + (unresolved.length ? `; left ${unresolved.length} with no derivable parent (ids: ${unresolved.join(', ')})` : '')
    );
  }

  console.log(`[20260926000001] total: ${stamped} row(s) stamped, ${skipped} left for a human.`);
}

export async function down() {
  // Intentionally not reversed. Re-NULLing by predicate would also clear the
  // rows that legitimately carry these companies — including every row stamped
  // correctly at INSERT time. To undo a specific run, use the row ids logged above.
}
