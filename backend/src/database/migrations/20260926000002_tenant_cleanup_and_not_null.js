/**
 * Migration: finish the tenant work started in 20260926000001.
 *
 * That migration stamped 28 of 36 NULL-tenant transactional rows from their
 * parent record and deliberately left three things for a human:
 *   (a) 5 rows whose parent does not exist,
 *   (b) 3 rows with no owner to derive from,
 *   (c) the NOT NULL constraint itself.
 * All three are handled here, now that the reason for deferring each is resolved.
 *
 * ── (a) pick_lists 21-25: DELETED ────────────────────────────────────────────
 * These are 2026-08-20 empty-table-seeder fixtures. `sales_order_ref` reads
 * "SEED sales order ref N" and `sales_order_id` is 1-5, none of which exist in
 * sales_orders (verified: 0 of 5). A pick list for a sales order that does not
 * exist cannot be stamped with a meaningful tenant and cannot be made correct by
 * any other means, so it is removed along with its one pick_list_lines child
 * each. This is the only DELETE in this migration.
 *
 * ── (b) three owner-less rows: STAMPED from their creator ────────────────────
 * leads 10 ("DB Test Company", already soft-deleted 2026-07-09),
 * travel_requests 300 ("DB write test"), engineering_changes 4 ("BOM version
 * bump — DIAG BOM v1 → v11"). Each has a NULL owner/employee FK, which is why
 * the parent-derivation in 20260926000001 could not resolve them — but each DOES
 * carry a creator (`created_by` / `requested_by`), and users 1, 848 and 849 all
 * carry company_id = 1. So the tenant is knowable after all, from a column the
 * first pass did not look at. They are stamped, not deleted: two have real
 * content and deleting rows is not something a migration should decide.
 *
 * ── (c) NOT NULL ─────────────────────────────────────────────────────────────
 * Deferred in 20260926000001 because adding the constraint while INSERT paths
 * omit the column just moves a silent NULL into a 500. That has now been fixed:
 * all 19 application INSERT sites across these ten tables were audited and each
 * one supplies company_id (journal_lines 8 sites, bom_lines 3,
 * production_operations 2, travel_requests 2, quotations 1, lifecycle_instances 1,
 * engineering_changes 1, plus the ones that already did).
 *
 * The constraint is applied ONLY to a table this migration can prove is clean:
 * each ALTER re-counts NULLs first and skips with a warning rather than failing
 * the deploy. That matters because this same file runs against databases whose
 * history is not this one's.
 */

const DELETE_PICK_LISTS = [21, 22, 23, 24, 25];

// table -> expression deriving the tenant from the row's CREATOR (not its parent)
const STAMP_FROM_CREATOR = [
  ['leads',               `(SELECT u.company_id FROM users u WHERE u.id = t.created_by)`],
  ['travel_requests',     `(SELECT u.company_id FROM users u WHERE u.id = t.created_by)`],
  ['engineering_changes', `(SELECT u.company_id FROM users u WHERE u.id = t.requested_by)`],
];

const NOT_NULL_TABLES = [
  'journal_lines', 'production_operations', 'bom_lines', 'quotations',
  'lifecycle_instances', 'attendance_records', 'pick_lists', 'leads',
  'travel_requests', 'engineering_changes',
];

async function tableHasColumn(knex, table, column) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows.length > 0;
}

export async function up(knex) {
  // ── (a) remove the dangling seeder pick lists ──────────────────────────────
  if (await tableHasColumn(knex, 'pick_lists', 'sales_order_id')) {
    const { rows: doomed } = await knex.raw(
      `SELECT pl.id FROM pick_lists pl
        WHERE pl.id = ANY($1::int[])
          AND pl.company_id IS NULL
          AND pl.sales_order_ref LIKE 'SEED sales order ref%'
          AND NOT EXISTS (SELECT 1 FROM sales_orders so WHERE so.id = pl.sales_order_id)`,
      [DELETE_PICK_LISTS]
    );
    // Every condition must still hold. If any does not, the row is not the one
    // this migration was written for and is left completely alone.
    if (doomed.length !== DELETE_PICK_LISTS.length) {
      console.warn(
        `[20260926000002] pick_lists: expected ${DELETE_PICK_LISTS.length} dangling seeder rows, matched ${doomed.length}. `
        + `Deleting only the matched ones: ${doomed.map(r => r.id).join(', ') || '(none)'}`
      );
    }
    const ids = doomed.map(r => r.id);
    if (ids.length) {
      const kids = await knex.raw(`DELETE FROM pick_list_lines WHERE pick_list_id = ANY($1::int[])`, [ids]);
      const heads = await knex.raw(`DELETE FROM pick_lists WHERE id = ANY($1::int[])`, [ids]);
      console.log(`[20260926000002] pick_lists: deleted ${heads.rowCount} header(s) and ${kids.rowCount} line(s) — ids ${ids.join(', ')}`);
    }
  }

  // ── (b) stamp the owner-less rows from their creator ───────────────────────
  for (const [table, expr] of STAMP_FROM_CREATOR) {
    if (!(await tableHasColumn(knex, table, 'company_id'))) continue;
    const { rows: before } = await knex.raw(
      `SELECT t.id, ${expr} AS derived FROM "${table}" t WHERE t.company_id IS NULL ORDER BY t.id`
    );
    if (!before.length) { console.log(`[20260926000002] ${table}: already clean.`); continue; }
    const res = await knex.raw(
      `UPDATE "${table}" t SET company_id = ${expr} WHERE t.company_id IS NULL AND ${expr} IS NOT NULL`
    );
    const left = before.filter(r => r.derived == null).map(r => r.id);
    console.log(
      `[20260926000002] ${table}: stamped ${res.rowCount || 0} of ${before.length} from creator`
      + (left.length ? `; ${left.length} still unresolved (ids: ${left.join(', ')})` : '')
    );
  }

  // ── (c) NOT NULL, but only where provably clean ────────────────────────────
  for (const table of NOT_NULL_TABLES) {
    if (!(await tableHasColumn(knex, table, 'company_id'))) continue;

    const { rows: [{ nulls }] } = await knex.raw(
      `SELECT COUNT(*)::int AS nulls FROM "${table}" WHERE company_id IS NULL`
    );
    if (nulls > 0) {
      console.warn(`[20260926000002] ${table}: ${nulls} NULL company_id row(s) remain — NOT NULL skipped.`);
      continue;
    }
    const { rows: [{ already }] } = await knex.raw(
      `SELECT (is_nullable = 'NO') AS already FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'company_id'`,
      [table]
    );
    if (already) { console.log(`[20260926000002] ${table}: already NOT NULL.`); continue; }

    await knex.raw(`ALTER TABLE "${table}" ALTER COLUMN company_id SET NOT NULL`);
    console.log(`[20260926000002] ${table}: company_id is now NOT NULL.`);
  }
}

export async function down(knex) {
  // Only the constraint is reversible. The deleted seeder pick lists and the
  // stamped tenants are not restored: re-NULLing by predicate would also clear
  // rows that legitimately carry company 1, and the deleted rows referenced
  // sales orders that never existed.
  for (const table of NOT_NULL_TABLES) {
    if (!(await tableHasColumn(knex, table, 'company_id'))) continue;
    await knex.raw(`ALTER TABLE "${table}" ALTER COLUMN company_id DROP NOT NULL`).catch(() => {});
  }
}
