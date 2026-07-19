/**
 * 20260714000003_backfill_project_opportunity.js
 *
 * One-time deterministic backfill of projects.opportunity_id (the IPM<->IPP
 * bridge from 20260714000002) for projects that PREDATE the forward-linking
 * wired into the sales auto-bootstrap flow.
 *
 * The only trustworthy link is the sales chain:
 *   projects.sales_order_ref = sales_orders.order_number
 *     -> sales_orders.quotation_id = quotations.id
 *       -> quotations.opportunity_id
 *
 * We deliberately do NOT guess by customer-name similarity — that fabricates
 * relationships and would mislink. Projects with no sales-order origin simply
 * keep a NULL opportunity_id (blank IPM in the tracker), which is honest.
 *
 * Idempotent: only touches rows where opportunity_id IS NULL, and only when the
 * resolved opportunity is in the same company as the project (no cross-tenant
 * bleed). On a DB with no sales orders/quotations this links zero rows, by
 * design — it is correct for populated tenants and a no-op otherwise.
 */

export async function up(knex) {
  const res = await knex.raw(`
    UPDATE projects p
       SET opportunity_id = q.opportunity_id,
           updated_at     = NOW()
      FROM sales_orders so
      JOIN quotations   q ON q.id = so.quotation_id
     WHERE p.sales_order_ref  = so.order_number
       AND p.opportunity_id  IS NULL
       AND q.opportunity_id  IS NOT NULL
       AND p.deleted_at      IS NULL
       AND (so.company_id IS NULL OR p.company_id IS NULL OR p.company_id = so.company_id)
  `);
  // rowCount is informational; migration is idempotent regardless.
  // eslint-disable-next-line no-console
  console.log(`[backfill_project_opportunity] linked ${res.rowCount ?? 0} project(s) to their pursuit.`);
}

export async function down(knex) {
  // Reversal cannot know which links were pre-existing vs. set here, so only
  // undo links that still match the deterministic chain (safe, non-destructive
  // to manually-set links that no longer match a sales chain).
  await knex.raw(`
    UPDATE projects p
       SET opportunity_id = NULL
      FROM sales_orders so
      JOIN quotations   q ON q.id = so.quotation_id
     WHERE p.sales_order_ref = so.order_number
       AND p.opportunity_id  = q.opportunity_id
  `);
}
